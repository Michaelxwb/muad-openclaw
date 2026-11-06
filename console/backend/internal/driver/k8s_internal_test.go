package driver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func fileRuntimeSpec(t *testing.T, podID string) PodSpec {
	t.Helper()
	raw, err := os.ReadFile("../../../../bin/test/fixtures/runtime-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	spec := testPodSpec(podID, "worker:file")
	if err := json.Unmarshal(raw, &spec.MultiUser); err != nil {
		t.Fatal(err)
	}
	spec.MultiUser.PodID = podID
	return spec
}

func TestRuntimeFileTask005_B02ResourcesAndIsolation(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	for _, id := range []string{"alice", "bob"} {
		spec := fileRuntimeSpec(t, id)
		if err := d.Create(ctx, spec); err != nil {
			t.Fatal(err)
		}
		name := ContainerName(id)
		sec, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-runtime-config", metav1.GetOptions{})
		if err != nil || sec.StringData[RuntimeConfigFileName] == "" {
			t.Fatalf("runtime Secret: %v", err)
		}
		dep, err := d.client.AppsV1().Deployments(d.namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		assertRuntimeFileDeployment(t, dep)
		env, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-env", metav1.GetOptions{})
		if err != nil || env.StringData["MUAD_RUNTIME_CONFIG"] != "" {
			t.Fatal("file env contains DTO")
		}
	}
	bob, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, ContainerName("bob")+"-runtime-config", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	spec := fileRuntimeSpec(t, "alice")
	spec.MultiUser.Generation++
	if err := d.SyncStartupConfig(ctx, spec); err != nil {
		t.Fatal(err)
	}
	after, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, bob.Name, metav1.GetOptions{})
	if err != nil || after.StringData[RuntimeConfigFileName] != bob.StringData[RuntimeConfigFileName] {
		t.Fatal("Pod A changed Pod B")
	}
}

func assertRuntimeFileDeployment(t *testing.T, dep *appsv1.Deployment) {
	t.Helper()
	c := dep.Spec.Template.Spec.Containers[0]
	if len(c.EnvFrom) != 0 {
		t.Fatal("file workload imports legacy envFrom")
	}
	if !hasVolumeMount(c.VolumeMounts, "runtime-config", RuntimeConfigDirectory) {
		t.Fatal("missing readonly runtime directory")
	}
	for _, mount := range c.VolumeMounts {
		if mount.Name == "runtime-config" && mount.SubPath != "" {
			t.Fatal("runtime mount uses subPath")
		}
	}
	for _, volume := range dep.Spec.Template.Spec.Volumes {
		if volume.Name == "runtime-config" && (volume.Secret == nil || *volume.Secret.DefaultMode != 0o440) {
			t.Fatal("unsafe Secret permissions")
		}
	}
	if *dep.Spec.Template.Spec.SecurityContext.FSGroup != DefaultRuntimeGID {
		t.Fatal("non-root cannot read Secret")
	}
}

func TestRuntimeFileTask005_B02PartialMigrationRetry(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	legacy := spec
	legacy.MultiUser = RuntimeConfigV1{}
	if err := d.Create(ctx, legacy); err != nil {
		t.Fatal(err)
	}
	name := ContainerName(spec.PodID)
	env, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-env", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	env.StringData["MUAD_RUNTIME_CONFIG"] = "legacy-runtime-sentinel"
	if _, err := d.client.CoreV1().Secrets(d.namespace).Update(ctx, env, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	fail := true
	d.client.(*fake.Clientset).PrependReactor("update", "deployments", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if fail {
			return true, nil, errors.New("rollout rejected")
		}
		return false, nil, nil
	})
	if err := d.ReplaceRuntime(ctx, spec); err == nil {
		t.Fatal("rollout error ignored")
	}
	env, err = d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-env", metav1.GetOptions{})
	if err != nil || env.StringData["MUAD_RUNTIME_CONFIG"] != "legacy-runtime-sentinel" {
		t.Fatal("legacy source lost before migration")
	}
	fail = false
	assertFileMigrationRetryCleanup(t, d, spec)
}

func assertFileMigrationRetryCleanup(t *testing.T, d *K8sDriver, spec PodSpec) {
	t.Helper()
	ctx := context.Background()
	name := ContainerName(spec.PodID)
	if err := d.ReplaceRuntime(ctx, spec); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := d.SyncStartupConfig(ctx, spec); err != nil {
			t.Fatal(err)
		}
	}
	env, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-env", metav1.GetOptions{})
	if err != nil || env.StringData["MUAD_RUNTIME_CONFIG"] != "" {
		t.Fatal("stale env not cleaned")
	}
	if err := d.Remove(ctx, spec.PodID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-runtime-config", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatal("runtime Secret leaked")
	}
	if _, err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Get(ctx, name+"-state", metav1.GetOptions{}); err != nil {
		t.Fatal("retained workspace deleted")
	}
}

// newFakeK8s builds a K8sDriver backed by a fake clientset (no real cluster).
func newFakeK8s(t *testing.T) *K8sDriver {
	t.Helper()
	return &K8sDriver{
		client:            fake.NewSimpleClientset(),
		namespace:         "muad",
		skillsPVC:         "muad-skills",
		publicSkillsMount: t.TempDir(),
		stateSize:         "5Gi",
	}
}

func TestK8s_CreateProvisionsAll(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.Channels = []string{"wechat"}
	spec.Resource.MemLimit = "3g"
	spec.Resource.CPULimit = "2"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// PVC + separate env/service-token Secrets + Deployment exist.
	if _, err := d.client.CoreV1().PersistentVolumeClaims("muad").Get(ctx, "muad-oc-alice-state", metav1.GetOptions{}); err != nil {
		t.Errorf("state PVC: %v", err)
	}
	if _, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-env", metav1.GetOptions{}); err != nil {
		t.Errorf("env secret: %v", err)
	}
	serviceSecret, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-service-token", metav1.GetOptions{})
	if err != nil || serviceSecret.StringData["pod-service-token"] != "service-token" {
		t.Errorf("service-token secret: %+v, %v", serviceSecret, err)
	}
	dep, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-alice", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("deployment: %v", err)
	}
	c := dep.Spec.Template.Spec.Containers[0]
	if c.Image != "img:1" {
		t.Errorf("image = %q", c.Image)
	}
	if got := c.Resources.Limits.Memory().String(); got != "3Gi" {
		t.Errorf("mem limit = %q, want 3Gi (docker 3g → 3Gi)", got)
	}
	if got := c.Resources.Limits.Cpu().String(); got != "2" {
		t.Errorf("cpu limit = %q, want 2", got)
	}
	// requests are clamped down to the pod's limits (3g/2) so requests never exceed
	// limits; otherwise Kubernetes rejects the Deployment write.
	if got := c.Resources.Requests.Cpu().String(); got != "2" {
		t.Errorf("cpu request = %q, want 2 (clamped to limit)", got)
	}
	if got := c.Resources.Requests.Memory().String(); got != "3Gi" {
		t.Errorf("mem request = %q, want 3Gi (clamped to limit)", got)
	}
	if dep.Spec.Strategy.Type != "Recreate" {
		t.Errorf("strategy = %q, want Recreate", dep.Spec.Strategy.Type)
	}
	if dep.Spec.Template.Spec.AutomountServiceAccountToken == nil ||
		*dep.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatal("worker Pod must not automount a service-account token")
	}
	assertWorkerPodSecurity(t, dep.Spec.Template.Spec.SecurityContext)
	assertWorkerContainerSecurity(t, c.SecurityContext)
	if c.ReadinessProbe == nil || c.ReadinessProbe.TCPSocket == nil ||
		c.ReadinessProbe.TCPSocket.Port.IntVal != GatewayPort {
		t.Fatalf("readiness probe = %+v, want TCP %d", c.ReadinessProbe, GatewayPort)
	}
	if c.LivenessProbe == nil || c.LivenessProbe.TCPSocket == nil ||
		c.LivenessProbe.TCPSocket.Port.IntVal != GatewayPort {
		t.Fatalf("liveness probe = %+v, want TCP %d", c.LivenessProbe, GatewayPort)
	}
	if c.StartupProbe == nil || c.StartupProbe.TCPSocket == nil ||
		c.StartupProbe.TCPSocket.Port.IntVal != GatewayPort ||
		c.StartupProbe.FailureThreshold < 60 {
		t.Fatalf("startup probe = %+v, want long TCP startup window", c.StartupProbe)
	}
	if len(dep.Spec.Template.Spec.InitContainers) != 0 {
		t.Fatalf("init containers = %d, want 0", len(dep.Spec.Template.Spec.InitContainers))
	}
	if !hasVolumeMount(c.VolumeMounts, "service-token-runtime", "/run/secrets/muad") {
		t.Fatal("main container is missing read-only service-token runtime mount")
	}
	assertServiceTokenVolume(t, dep.Spec.Template.Spec.Volumes, "muad-oc-alice")
}

func TestK8sCreateAppliesWorkerNodeSelector(t *testing.T) {
	d := newFakeK8s(t)
	d.workerNodeSelector = map[string]string{"app": "openclaw"}
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")

	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	dep, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-alice", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("deployment: %v", err)
	}
	if dep.Spec.Template.Spec.NodeSelector["app"] != "openclaw" {
		t.Fatalf("worker nodeSelector = %+v, want app=openclaw", dep.Spec.Template.Spec.NodeSelector)
	}
}

func assertWorkerPodSecurity(t *testing.T, security *corev1.PodSecurityContext) {
	t.Helper()
	if security == nil || security.RunAsNonRoot == nil || !*security.RunAsNonRoot {
		t.Fatalf("pod security context = %+v, want runAsNonRoot", security)
	}
	if security.RunAsUser == nil || *security.RunAsUser != DefaultRuntimeUID ||
		security.FSGroup == nil || *security.FSGroup != DefaultRuntimeGID {
		t.Fatalf("pod uid/gid security context = %+v", security)
	}
	if security.SeccompProfile == nil ||
		security.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatalf("pod seccomp profile = %+v", security.SeccompProfile)
	}
}

func assertWorkerContainerSecurity(t *testing.T, security *corev1.SecurityContext) {
	t.Helper()
	if security == nil || security.AllowPrivilegeEscalation == nil ||
		*security.AllowPrivilegeEscalation {
		t.Fatalf("container security context = %+v, want no privilege escalation", security)
	}
	if security.Capabilities == nil || len(security.Capabilities.Drop) != 1 ||
		security.Capabilities.Drop[0] != "ALL" {
		t.Fatalf("container capabilities = %+v, want drop ALL", security.Capabilities)
	}
}

func assertServiceTokenVolume(t *testing.T, volumes []corev1.Volume, name string) {
	t.Helper()
	for _, volume := range volumes {
		if volume.Name != "service-token-runtime" {
			continue
		}
		if volume.Secret == nil {
			t.Fatalf("service-token-runtime volume = %+v, want Secret", volume.VolumeSource)
		}
		secret := volume.Secret
		if secret.SecretName != name+"-service-token" {
			t.Fatalf("service-token secret name = %q", secret.SecretName)
		}
		if secret.DefaultMode == nil || *secret.DefaultMode != 0o440 {
			t.Fatalf("service-token default mode = %v, want 0440", secret.DefaultMode)
		}
		if len(secret.Items) != 1 || secret.Items[0].Key != "pod-service-token" ||
			secret.Items[0].Path != "pod-service-token" ||
			secret.Items[0].Mode == nil || *secret.Items[0].Mode != 0o440 {
			t.Fatalf("service-token items = %+v, want pod-service-token mode 0440", secret.Items)
		}
		return
	}
	t.Fatal("missing service-token-runtime Secret volume")
}

func TestK8s_EnsurePublicSkillsStorageCreatesRWXPVC(t *testing.T) {
	d := newFakeK8s(t)
	d.skillsStorageClass = "nfs-rwx"
	d.skillsSize = "7Gi"
	ctx := context.Background()

	status, err := d.PublicSkillsStorageStatus(ctx)
	if err != nil {
		t.Fatalf("PublicSkillsStorageStatus: %v", err)
	}
	if status.Ready || status.Phase != "Missing" {
		t.Fatalf("initial public Skill storage status = %+v", status)
	}

	status, err = d.EnsurePublicSkillsStorage(ctx)
	if err != nil {
		t.Fatalf("EnsurePublicSkillsStorage: %v", err)
	}
	if status.Name != "muad-skills" || status.AccessMode != "ReadWriteMany" || status.Size != "7Gi" {
		t.Fatalf("ensured public Skill storage status = %+v", status)
	}
	pvc, err := d.client.CoreV1().PersistentVolumeClaims("muad").Get(
		ctx, "muad-skills", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatalf("public Skill PVC: %v", err)
	}
	if got := pvc.Spec.AccessModes[0]; got != corev1.ReadWriteMany {
		t.Fatalf("access mode = %s", got)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != "nfs-rwx" {
		t.Fatalf("storage class = %v", pvc.Spec.StorageClassName)
	}
}

func TestK8s_PublicSkillsStorageRejectsBoundNonRWXPVC(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "muad-skills", Namespace: "muad"},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
		},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	if _, err := d.client.CoreV1().PersistentVolumeClaims("muad").Create(ctx, pvc, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create public Skill PVC: %v", err)
	}

	status, err := d.PublicSkillsStorageStatus(ctx)
	if err != nil {
		t.Fatalf("PublicSkillsStorageStatus: %v", err)
	}
	if status.Ready || status.AccessMode != string(corev1.ReadWriteOnce) {
		t.Fatalf("RWO public Skill PVC should not be ready: %+v", status)
	}
	if status.Message != "Public Skill PVC 必须支持 ReadWriteMany" {
		t.Fatalf("message = %q", status.Message)
	}
}

func TestK8s_SyncPublicSkillsFailsFastWhenPVCNotReady(t *testing.T) {
	d := newFakeK8s(t)
	err := d.SyncPublicSkills(context.Background(), "pod-a", t.TempDir())
	if !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("SyncPublicSkills without ready PVC = %v, want ErrRuntimeNotReady", err)
	}
}

func TestK8s_SyncPublicSkillsWritesConsoleMountAndPatchesWorker(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	if _, err := d.client.CoreV1().PersistentVolumeClaims("muad").Create(ctx, &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "muad-skills", Namespace: "muad"},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
		},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create public Skill PVC: %v", err)
	}
	if err := d.Create(ctx, testPodSpec("pod-a", "img:1")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	source := t.TempDir()
	writeDockerSkillFile(t, source, "enabled-skill", "SKILL.md", "# enabled\n")

	if err := d.SyncPublicSkills(ctx, "pod-a", source); err != nil {
		t.Fatalf("SyncPublicSkills: %v", err)
	}
	activeRoot := filepath.Join(d.publicSkillsMount, dockerActivePublicSkillsDir)
	if _, err := os.ReadFile(filepath.Join(activeRoot, "enabled-skill", "SKILL.md")); err != nil {
		t.Fatalf("public Skill was not written through Console mount: %v", err)
	}
	dep, err := d.client.AppsV1().Deployments("muad").Get(ctx, ContainerName("pod-a"), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get worker deployment: %v", err)
	}
	if !hasVolumeMountWithSubPath(
		dep.Spec.Template.Spec.Containers[0].VolumeMounts,
		"skills", "/opt/openclaw-skills", dockerActivePublicSkillsDir,
	) {
		t.Fatalf("worker deployment missing active public Skill subPath mount: %+v",
			dep.Spec.Template.Spec.Containers[0].VolumeMounts)
	}
	pods, err := d.client.CoreV1().Pods("muad").List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list pods: %v", err)
	}
	if len(pods.Items) != 0 {
		t.Fatalf("SyncPublicSkills should not create temporary pods: %+v", pods.Items)
	}
}

func TestK8s_PublicSkillsStorageRequiresConsoleMountPath(t *testing.T) {
	d := newFakeK8s(t)
	d.publicSkillsMount = ""
	ctx := context.Background()
	status, err := d.PublicSkillsStorageStatus(ctx)
	if err != nil {
		t.Fatalf("PublicSkillsStorageStatus: %v", err)
	}
	if status.Configured || status.Message != "未配置 k8s.publicSkillsMountPath" {
		t.Fatalf("status without mount path = %+v", status)
	}
	if err := d.SyncPublicSkills(ctx, "pod-a", t.TempDir()); !errors.Is(err, ErrInvalidPodSpec) {
		t.Fatalf("SyncPublicSkills without mount path = %v, want ErrInvalidPodSpec", err)
	}
}

func TestK8s_DeploymentDoesNotMountPublicSkillsWhenStorageUnpaired(t *testing.T) {
	d := newFakeK8s(t)
	d.publicSkillsMount = ""

	dep := d.deployment(testPodSpec("pod-a", "img:1"), ContainerName("pod-a"))
	if hasPVCVolume(dep.Spec.Template.Spec.Volumes, "skills", "muad-skills", true) {
		t.Fatal("deployment should not include public Skill volume without Console mount path")
	}
	if hasVolumeMount(dep.Spec.Template.Spec.Containers[0].VolumeMounts, "skills", "/opt/openclaw-skills") {
		t.Fatal("deployment should not mount public Skill volume without active subPath")
	}
}

func TestK8s_EnsurePublicSkillsMountPatchesExistingDeployment(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	name := ContainerName("legacy")
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "muad"},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: d.labels("legacy")},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: d.labels("legacy")},
				Spec: corev1.PodSpec{
					Volumes: []corev1.Volume{{
						Name: "state",
						VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
							ClaimName: name + "-state",
						}},
					}},
					Containers: []corev1.Container{{
						Name: "openclaw", Image: "img:1",
						VolumeMounts: []corev1.VolumeMount{{Name: "state", MountPath: "/home/node/.openclaw"}},
					}},
				},
			},
		},
	}
	if _, err := d.client.AppsV1().Deployments("muad").Create(ctx, dep, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create legacy deployment: %v", err)
	}
	if err := d.ensurePublicSkillsMount(ctx, "legacy"); err != nil {
		t.Fatalf("ensurePublicSkillsMount: %v", err)
	}
	got, err := d.client.AppsV1().Deployments("muad").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get patched deployment: %v", err)
	}
	if !hasPVCVolume(got.Spec.Template.Spec.Volumes, "skills", "muad-skills", true) {
		t.Fatal("deployment is missing read-only public Skill PVC volume")
	}
	if !hasVolumeMount(got.Spec.Template.Spec.Containers[0].VolumeMounts, "skills", "/opt/openclaw-skills") {
		t.Fatal("deployment is missing read-only public Skill mount")
	}
	if !hasVolumeMountWithSubPath(
		got.Spec.Template.Spec.Containers[0].VolumeMounts,
		"skills", "/opt/openclaw-skills", dockerActivePublicSkillsDir,
	) {
		t.Fatal("deployment public Skill mount is missing active subPath")
	}
}

func TestK8s_EnsurePublicSkillsMountRetriesUpdateConflict(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	name := ContainerName("legacy")
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "muad"},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: d.labels("legacy")},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: d.labels("legacy")},
				Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "openclaw", Image: "img:1"}}},
			},
		},
	}
	if _, err := d.client.AppsV1().Deployments("muad").Create(ctx, dep, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create legacy deployment: %v", err)
	}
	client := d.client.(*fake.Clientset)
	conflicts := 1
	client.Fake.PrependReactor("update", "deployments", func(k8stesting.Action) (bool, runtime.Object, error) {
		if conflicts == 0 {
			return false, nil, nil
		}
		conflicts--
		err := errors.New("resource version changed")
		resource := schema.GroupResource{Group: "apps", Resource: "deployments"}
		return true, nil, apierrors.NewConflict(resource, name, err)
	})

	if err := d.ensurePublicSkillsMount(ctx, "legacy"); err != nil {
		t.Fatalf("ensurePublicSkillsMount: %v", err)
	}
	if conflicts != 0 {
		t.Fatal("expected one simulated update conflict")
	}
	got, err := d.client.AppsV1().Deployments("muad").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get patched deployment: %v", err)
	}
	if !hasVolumeMountWithSubPath(
		got.Spec.Template.Spec.Containers[0].VolumeMounts,
		"skills", "/opt/openclaw-skills", dockerActivePublicSkillsDir,
	) {
		t.Fatal("deployment public Skill mount is missing active subPath")
	}
}

func TestK8s_EnsurePublicSkillsMountReplacesStaleVolumeAndMount(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	name := ContainerName("legacy")
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "muad"},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: d.labels("legacy")},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: d.labels("legacy")},
				Spec: corev1.PodSpec{
					Volumes: []corev1.Volume{{
						Name: "skills",
						VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
							ClaimName: "old-skills", ReadOnly: false,
						}},
					}},
					Containers: []corev1.Container{{
						Name: "openclaw", Image: "img:1",
						VolumeMounts: []corev1.VolumeMount{{
							Name: "old-skills", MountPath: "/opt/openclaw-skills", ReadOnly: false,
						}},
					}},
				},
			},
		},
	}
	if _, err := d.client.AppsV1().Deployments("muad").Create(ctx, dep, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create stale deployment: %v", err)
	}

	if err := d.ensurePublicSkillsMount(ctx, "legacy"); err != nil {
		t.Fatalf("ensurePublicSkillsMount: %v", err)
	}
	got, err := d.client.AppsV1().Deployments("muad").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get patched deployment: %v", err)
	}
	if !hasPVCVolume(got.Spec.Template.Spec.Volumes, "skills", "muad-skills", true) {
		t.Fatal("stale public Skill PVC volume was not replaced")
	}
	if !hasVolumeMount(got.Spec.Template.Spec.Containers[0].VolumeMounts, "skills", "/opt/openclaw-skills") {
		t.Fatal("stale public Skill mount was not replaced")
	}
	if !hasVolumeMountWithSubPath(
		got.Spec.Template.Spec.Containers[0].VolumeMounts,
		"skills", "/opt/openclaw-skills", dockerActivePublicSkillsDir,
	) {
		t.Fatal("stale public Skill mount was not replaced with active subPath")
	}
}

func TestK8s_StartStopScales(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	_ = d.Create(ctx, testPodSpec("bob", "img:1"))

	if err := d.Stop(ctx, "bob"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	dep, _ := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-bob", metav1.GetOptions{})
	if *dep.Spec.Replicas != 0 {
		t.Errorf("after Stop replicas = %d, want 0", *dep.Spec.Replicas)
	}
	if err := d.Start(ctx, "bob"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	dep, _ = d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-bob", metav1.GetOptions{})
	if *dep.Spec.Replicas != 1 {
		t.Errorf("after Start replicas = %d, want 1", *dep.Spec.Replicas)
	}
}

func TestK8s_RemoveKeepStateVsDeleteVolume(t *testing.T) {
	ctx := context.Background()

	// keepState=true → PVC stays
	d := newFakeK8s(t)
	_ = d.Create(ctx, testPodSpec("carol", "img:1"))
	if err := d.Remove(ctx, "carol", true); err != nil {
		t.Fatalf("Remove keepState: %v", err)
	}
	if _, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-carol", metav1.GetOptions{}); err == nil {
		t.Error("deployment should be deleted")
	}
	pvc, err := d.client.CoreV1().PersistentVolumeClaims("muad").Get(ctx, "muad-oc-carol-state", metav1.GetOptions{})
	if err != nil {
		t.Error("PVC should be kept when keepState=true")
	}
	if pvc.Annotations["muad/state-retained"] != "true" {
		t.Errorf("retained annotation = %q, want true", pvc.Annotations["muad/state-retained"])
	}
	if err := d.Create(ctx, testPodSpec("carol", "img:1")); !errors.Is(err, ErrRetainedState) {
		t.Fatalf("create without adopt = %v, want ErrRetainedState", err)
	}
	adopt := testPodSpec("carol", "img:1")
	adopt.AdoptState = true
	if err := d.Create(ctx, adopt); err != nil {
		t.Fatalf("explicit adopt: %v", err)
	}

	// keepState=false → PVC deleted
	d2 := newFakeK8s(t)
	_ = d2.Create(ctx, testPodSpec("dave", "img:1"))
	if err := d2.Remove(ctx, "dave", false); err != nil {
		t.Fatalf("Remove deleteVolume: %v", err)
	}
	if _, err := d2.client.CoreV1().PersistentVolumeClaims("muad").Get(ctx, "muad-oc-dave-state", metav1.GetOptions{}); err == nil {
		t.Error("PVC should be deleted when keepState=false")
	}
}

func TestK8s_RemoveIdempotent(t *testing.T) {
	d := newFakeK8s(t)
	if err := d.Remove(context.Background(), "ghost", false); err != nil {
		t.Errorf("Remove of absent user should be nil, got %v", err)
	}
}

func TestK8s_UpdateSpecRotatesOnlyServiceToken(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("rotate", "img:1")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}

	spec.GatewayToken = "must-not-replace-existing"
	spec.ServiceToken.Value = "rotated-service-token"
	if err := d.UpdateServiceToken(ctx, spec.PodID, spec.ServiceToken); err != nil {
		t.Fatalf("UpdateServiceToken: %v", err)
	}

	envSecret, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-rotate-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get env Secret: %v", err)
	}
	if got := envSecret.StringData["OPENCLAW_GATEWAY_TOKEN"]; got != "gateway-token" {
		t.Errorf("gateway token = %q, want preserved value", got)
	}
	if secretContains(envSecret, "rotated-service-token") {
		t.Fatal("service token leaked into environment Secret")
	}

	serviceSecret, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-rotate-service-token", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get service-token Secret: %v", err)
	}
	if got := serviceSecret.StringData["pod-service-token"]; got != "rotated-service-token" {
		t.Errorf("service token = %q, want rotated value", got)
	}
}

func TestK8s_ListMapsState(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	_ = d.Create(ctx, testPodSpec("alice", "img:1"))
	_ = d.Create(ctx, testPodSpec("bob", "img:2"))
	_ = d.Stop(ctx, "bob")

	infos, err := d.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := map[string]string{}
	for _, i := range infos {
		got[i.PodID] = i.State
	}
	if got["bob"] != "stopped" {
		t.Errorf("bob state = %q, want stopped", got["bob"])
	}
	// alice: replicas=1 but fake has no AvailableReplicas → "creating"
	if got["alice"] != "creating" && got["alice"] != "running" {
		t.Errorf("alice state = %q", got["alice"])
	}
}

func TestK8s_PodNameWaitsForRunningPod(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "muad-oc-wait-1", Namespace: "muad", Labels: map[string]string{"muad-pod": "wait"}},
		Status:     corev1.PodStatus{Phase: corev1.PodPending},
	}
	if _, err := d.client.CoreV1().Pods("muad").Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create Pod: %v", err)
	}
	if _, err := d.podName(ctx, "wait"); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("pending podName error = %v, want ErrRuntimeNotReady", err)
	}
	pod.Status.Phase = corev1.PodRunning
	if _, err := d.client.CoreV1().Pods("muad").UpdateStatus(ctx, pod, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update Pod status: %v", err)
	}
	if got, err := d.podName(ctx, "wait"); err != nil || got != pod.Name {
		t.Fatalf("running podName = %q, %v", got, err)
	}
}

func TestK8s_PodNameTreatsMissingPodAsNotReady(t *testing.T) {
	d := newFakeK8s(t)
	if _, err := d.podName(context.Background(), "missing"); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("missing podName error = %v, want ErrRuntimeNotReady", err)
	}
}

// testPodSpec builds a spec with MultiUser left zero (= env startup mode). Tests
// that care about file-mode behaviour must call fileRuntimeSpec or set
// MultiUser themselves: PodSpec.Validate is mode-aware, so with a zero MultiUser
// it only checks the env-mode fields and never exercises the embedded Runtime DTO.
func testPodSpec(podID, image string) PodSpec {
	return PodSpec{
		PodID: podID, ImageTag: image, GatewayToken: "gateway-token",
		Resource: ResourceSpec{
			MemLimit: "2g", CPULimit: "1", RestartPolicy: "unless-stopped",
			MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1, MaxLongTaskConcurrency: 2,
		},
		ServiceToken: SecretFileSpec{
			Name: podID + "-service-token", ContainerPath: PodServiceTokenPath,
			Value: "service-token", Mode: 0o400, UID: DefaultRuntimeUID, GID: DefaultRuntimeGID,
		},
	}
}

func hasVolumeMount(mounts []corev1.VolumeMount, name, path string) bool {
	for _, mount := range mounts {
		if mount.Name == name && mount.MountPath == path && mount.ReadOnly {
			return true
		}
	}
	return false
}

func hasVolumeMountWithSubPath(mounts []corev1.VolumeMount, name, mountPath, subPath string) bool {
	for _, mount := range mounts {
		if mount.Name == name && mount.MountPath == mountPath &&
			mount.ReadOnly && mount.SubPath == subPath {
			return true
		}
	}
	return false
}

func hasPVCVolume(volumes []corev1.Volume, name, claimName string, readOnly bool) bool {
	for _, volume := range volumes {
		if volume.Name != name || volume.PersistentVolumeClaim == nil {
			continue
		}
		pvc := volume.PersistentVolumeClaim
		if pvc.ClaimName == claimName && pvc.ReadOnly == readOnly {
			return true
		}
	}
	return false
}

func secretContains(secret *corev1.Secret, value string) bool {
	for _, candidate := range secret.StringData {
		if candidate == value {
			return true
		}
	}
	for _, candidate := range secret.Data {
		if string(candidate) == value {
			return true
		}
	}
	return false
}

func TestToK8sMem(t *testing.T) {
	cases := map[string]string{"2g": "2Gi", "512m": "512Mi", "3g": "3Gi", "12g": "12Gi", "1024k": "1024Ki", "": ""}
	for in, want := range cases {
		if got := toK8sMem(in); got != want {
			t.Errorf("toK8sMem(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestResourceReqsDefaults verifies the claw Pod's default requests (3C/8Gi)
// and fallback limits (6C/12Gi) so requests never exceed limits.
func TestResourceReqsDefaults(t *testing.T) {
	spec := PodSpec{Resource: ResourceSpec{}}
	rr := resourceReqs(spec)
	if got := rr.Requests.Cpu().String(); got != "3" {
		t.Errorf("default request cpu = %q, want 3", got)
	}
	if got := rr.Requests.Memory().String(); got != "8Gi" {
		t.Errorf("default request memory = %q, want 8Gi", got)
	}
	if got := rr.Limits.Cpu().String(); got != "6" {
		t.Errorf("fallback limit cpu = %q, want 6", got)
	}
	if got := rr.Limits.Memory().String(); got != "12Gi" {
		t.Errorf("fallback limit memory = %q, want 12Gi", got)
	}
}

// TestResourceReqsClampsToLimits verifies a small pod's requests are clamped down to
// its resolved limits, so requests never exceed limits (Kubernetes rejects any
// Deployment write with requests > limits).
func TestResourceReqsClampsToLimits(t *testing.T) {
	spec := PodSpec{Resource: ResourceSpec{CPULimit: "2", MemLimit: "3g"}}
	rr := resourceReqs(spec)
	if got := rr.Requests.Cpu().String(); got != "2" {
		t.Errorf("small-pod request cpu = %q, want 2 (clamped to limit)", got)
	}
	if got := rr.Requests.Memory().String(); got != "3Gi" {
		t.Errorf("small-pod request memory = %q, want 3Gi (clamped to limit)", got)
	}
	if got := rr.Limits.Cpu().String(); got != "2" {
		t.Errorf("small-pod limit cpu = %q, want 2", got)
	}
	if got := rr.Limits.Memory().String(); got != "3Gi" {
		t.Errorf("small-pod limit memory = %q, want 3Gi", got)
	}
	if rr.Requests.Cpu().Cmp(*rr.Limits.Cpu()) > 0 {
		t.Errorf("request cpu %s exceeds limit %s", rr.Requests.Cpu().String(), rr.Limits.Cpu().String())
	}
	if rr.Requests.Memory().Cmp(*rr.Limits.Memory()) > 0 {
		t.Errorf("request memory %s exceeds limit %s", rr.Requests.Memory().String(), rr.Limits.Memory().String())
	}
}

func TestK8s_WorkloadBlockedImagePullBackOff(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	if err := createTestWorkerPod(ctx, d, "pod-a", "ImagePullBackOff", nil); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	blocked, err := d.WorkloadBlocked(ctx, "pod-a")
	if err != nil || !blocked {
		t.Fatalf("WorkloadBlocked = %v, %v; want true (live ImagePullBackOff pod)", blocked, err)
	}
}

func TestK8s_WorkloadBlockedSkipsTerminatingPod(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	now := metav1.Now()
	if err := createTestWorkerPod(ctx, d, "pod-a", "ImagePullBackOff", &now); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	blocked, err := d.WorkloadBlocked(ctx, "pod-a")
	if err != nil || blocked {
		t.Fatalf("WorkloadBlocked = %v, %v; want false (terminating pod ignored)", blocked, err)
	}
}

func createTestWorkerPod(
	ctx context.Context, d *K8sDriver, name, waitingReason string, deletionTimestamp *metav1.Time,
) error {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: d.namespace,
			Labels: map[string]string{"muad-pod": name},
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{
				State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: waitingReason}},
			}},
		},
	}
	if deletionTimestamp != nil {
		pod.DeletionTimestamp = deletionTimestamp
	}
	_, err := d.client.CoreV1().Pods(d.namespace).Create(ctx, pod, metav1.CreateOptions{})
	return err
}

func TestK8s_RestartMissingWorkloadReturnsErrWorkloadMissing(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	err := d.Restart(ctx, "pod-missing")
	if !errors.Is(err, ErrWorkloadMissing) {
		t.Fatalf("Restart on missing Deployment = %v, want ErrWorkloadMissing", err)
	}
}

func TestK8s_ScaleMissingWorkloadReturnsErrWorkloadMissing(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	if err := d.Start(ctx, "pod-missing"); !errors.Is(err, ErrWorkloadMissing) {
		t.Fatalf("Start on missing Deployment = %v, want ErrWorkloadMissing", err)
	}
	if err := d.Stop(ctx, "pod-missing"); !errors.Is(err, ErrWorkloadMissing) {
		t.Fatalf("Stop on missing Deployment = %v, want ErrWorkloadMissing", err)
	}
}

func TestRestartTimestampUniqueWithinSameSecond(t *testing.T) {
	base := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	first := restartTimestamp(base)
	second := restartTimestamp(base.Add(500 * time.Millisecond))
	if first == second {
		t.Fatalf("two restarts within one second produced the same annotation %q", first)
	}
	if _, err := strconv.ParseInt(first, 10, 64); err != nil {
		t.Fatalf("restart annotation %q is not an integer timestamp: %v", first, err)
	}
}

func TestK8s_RestartBumpsAnnotationEachCall(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("restart-me", "img:1")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := d.Restart(ctx, "restart-me"); err != nil {
		t.Fatalf("first Restart: %v", err)
	}
	dep, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-restart-me", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	first := dep.Spec.Template.Annotations["muad/restartedAt"]
	if err := d.Restart(ctx, "restart-me"); err != nil {
		t.Fatalf("second Restart: %v", err)
	}
	dep, err = d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-restart-me", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get deployment after second Restart: %v", err)
	}
	second := dep.Spec.Template.Annotations["muad/restartedAt"]
	if first == "" || second == "" {
		t.Fatalf("restartedAt annotations missing: first=%q second=%q", first, second)
	}
	if first == second {
		t.Fatalf("second Restart did not change the template annotation: %q", first)
	}
}

func TestK8s_PodNameSkipsTerminatingPod(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	now := metav1.Now()
	terminating := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              "muad-oc-rotate-old",
			Namespace:         "muad",
			Labels:            map[string]string{"muad-pod": "rotate"},
			DeletionTimestamp: &now,
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if _, err := d.client.CoreV1().Pods("muad").Create(ctx, terminating, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create terminating Pod: %v", err)
	}
	if name, err := d.podName(ctx, "rotate"); err == nil {
		t.Fatalf("podName selected terminating Pod %q, want ErrRuntimeNotReady", name)
	} else if !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("podName error = %v, want ErrRuntimeNotReady", err)
	}
	// A healthy running Pod of the same workload wins over the terminating one.
	healthy := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "muad-oc-rotate-new", Namespace: "muad", Labels: map[string]string{"muad-pod": "rotate"}},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if _, err := d.client.CoreV1().Pods("muad").Create(ctx, healthy, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create healthy Pod: %v", err)
	}
	if name, err := d.podName(ctx, "rotate"); err != nil || name != healthy.Name {
		t.Fatalf("podName = %q, %v; want %q", name, err, healthy.Name)
	}
}

// MSS_ENV_PATH wiring: a configured Skill env file must produce a read-only
// Secret volume at the file's directory plus the env var, and the Secret must
// survive redeploys with the operator's content intact.
func TestK8s_SkillEnvFileMountsReadOnlySecretAndInjectsEnv(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	dep, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-alice", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	container := dep.Spec.Template.Spec.Containers[0]
	if !hasVolumeMount(container.VolumeMounts, "skill-env", "/opt/openclaw-secret") {
		t.Fatalf("skill-env mount missing: %+v", container.VolumeMounts)
	}
	if !hasVolume(dep.Spec.Template.Spec.Volumes, "skill-env", "muad-oc-alice-skill-env") {
		t.Fatalf("skill-env volume missing: %+v", dep.Spec.Template.Spec.Volumes)
	}
	if got := envValue(container.Env, SkillEnvFilePathEnvVar); got != "/opt/openclaw-secret/.env.ppt" {
		t.Fatalf("%s = %q, want configured path", SkillEnvFilePathEnvVar, got)
	}
	sec, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("skill env Secret: %v", err)
	}
	// ensureSkillEnvSecret creates the Secret with StringData, and the fake
	// ObjectTracker stores it verbatim without the API server's conversion to
	// Data, so the key lives in StringData here.
	if _, ok := sec.StringData[".env.ppt"]; !ok {
		t.Fatalf("Secret missing .env.ppt key: stringData=%+v data=%+v", sec.StringData, sec.Data)
	}
	// The key is the file's basename and KeyToPath must project it to that same
	// name inside the mounted directory, or MSS_ENV_PATH points at nothing.
	for _, vol := range dep.Spec.Template.Spec.Volumes {
		if vol.Secret == nil || vol.Name != "skill-env" {
			continue
		}
		items := vol.Secret.Items
		if len(items) != 1 || items[0].Key != ".env.ppt" || items[0].Path != ".env.ppt" {
			t.Fatalf("skill-env secret items = %+v, want key and path both .env.ppt", items)
		}
	}
}

func TestK8s_SkillEnvFileAbsentKeepsPreviousBehaviour(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	dep, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-alice", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	container := dep.Spec.Template.Spec.Containers[0]
	for _, mount := range container.VolumeMounts {
		if mount.Name == "skill-env" {
			t.Fatalf("unexpected skill-env mount: %+v", mount)
		}
	}
	if got := envValue(container.Env, SkillEnvFilePathEnvVar); got != "" {
		t.Fatalf("%s = %q, want empty when unconfigured", SkillEnvFilePathEnvVar, got)
	}
	if _, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("skill env Secret should not exist, err = %v", err)
	}
}

func TestK8s_EnsureSkillEnvSecretPreservesOperatorContent(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Operator fills in the key out of band.
	sec, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get Secret: %v", err)
	}
	sec.Data = map[string][]byte{".env.ppt": []byte("OPENAI_API_KEY=real-key")}
	if _, err := d.client.CoreV1().Secrets("muad").Update(ctx, sec, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("fill Secret: %v", err)
	}
	// A redeploy must not wipe it.
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("redeploy: %v", err)
	}
	after, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get Secret after redeploy: %v", err)
	}
	if got := string(after.Data[".env.ppt"]); got != "OPENAI_API_KEY=real-key" {
		t.Fatalf(".env.ppt = %q, want operator value preserved", got)
	}
}

// Inline content makes config.yaml the single source of truth: the Secret is
// created with the payload, and a changed payload rewrites it.
func TestK8s_EnsureSkillEnvSecretWritesConfiguredContent(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	spec.SkillEnvFileContent = "OPENAI_API_KEY=from-config"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := skillEnvSecretString(t, d, ctx); got != "OPENAI_API_KEY=from-config" {
		t.Fatalf(".env.ppt = %q, want configured content", got)
	}
	// A later deploy with new content must replace the payload.
	spec.SkillEnvFileContent = "OPENAI_API_KEY=rotated"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("redeploy: %v", err)
	}
	if got := skillEnvSecretString(t, d, ctx); got != "OPENAI_API_KEY=rotated" {
		t.Fatalf(".env.ppt = %q, want rotated content", got)
	}
}

// Same content on a repeated deploy must not rewrite the Secret, otherwise every
// reconcile would bump the Deployment and bounce the Pod.
func TestK8s_EnsureSkillEnvSecretStableContentIsNoOp(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	spec.SkillEnvFileContent = "OPENAI_API_KEY=stable"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	before := skillEnvSecretResourceVersion(t, d, ctx)
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("redeploy: %v", err)
	}
	if after := skillEnvSecretResourceVersion(t, d, ctx); after != before {
		t.Fatalf("resourceVersion changed %q -> %q, want unchanged payload left alone", before, after)
	}
}

// Empty content keeps the operator-owned behaviour: an existing payload is
// never overwritten, even when it was written by hand.
func TestK8s_EnsureSkillEnvSecretEmptyContentKeepsOperatorValue(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	sec, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get Secret: %v", err)
	}
	sec.Data = map[string][]byte{".env.ppt": []byte("OPENAI_API_KEY=hand-written")}
	if _, err := d.client.CoreV1().Secrets("muad").Update(ctx, sec, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("fill Secret: %v", err)
	}
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("redeploy: %v", err)
	}
	if got := skillEnvSecretString(t, d, ctx); got != "OPENAI_API_KEY=hand-written" {
		t.Fatalf(".env.ppt = %q, want hand-written value preserved", got)
	}
}

// The fake client stores StringData verbatim, so read both maps.
func skillEnvSecretString(t *testing.T, d *K8sDriver, ctx context.Context) string {
	t.Helper()
	sec, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get skill env Secret: %v", err)
	}
	if v, ok := sec.Data[".env.ppt"]; ok {
		return string(v)
	}
	return sec.StringData[".env.ppt"]
}

func skillEnvSecretResourceVersion(t *testing.T, d *K8sDriver, ctx context.Context) string {
	t.Helper()
	sec, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get skill env Secret: %v", err)
	}
	return sec.ResourceVersion
}

func TestK8s_SkillEnvFileValidation(t *testing.T) {
	// Validate is mode-aware: with Version != 0 it also checks MultiUser.PodID
	// against PodID, so the file-mode fixture is used to keep the runtime DTO
	// consistent. A zero MultiUser skips those fields entirely.
	for _, value := range []string{
		"/.env", "//.env", "/run", "relative/.env", "/opt/x/",
		// A ".." segment normalises into the service-token mount, so the
		// reserved-mount set must reject it rather than compare the literal string.
		"/opt/openclaw-secret/../run/secrets/muad/.env.ppt",
		"/x/../../../run/secrets/muad/.env.ppt",
		"/opt/openclaw-secret/./.env.ppt",
		// The docker driver splices the path into "-v host:container:ro", so a
		// ':' would truncate the mount target instead of failing.
		"/opt/openclaw-secret/.env.ppt:Z",
		"/opt/openclaw-secret/.env.ppt:x",
		// A tab survives TrimSpace and leaves an unaddressable path.
		"/opt/openclaw-secret/.env\t.ppt",
	} {
		spec := fileRuntimeSpec(t, "alice")
		spec.SkillEnvFile = value
		if err := spec.Validate(); err == nil {
			t.Fatalf("Validate accepted unsafe SkillEnvFile %q", value)
		}
	}
	spec := fileRuntimeSpec(t, "alice")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	if err := spec.Validate(); err != nil {
		t.Fatalf("Validate rejected valid SkillEnvFile: %v", err)
	}
}

// Inline content is only useful when it names a file; content without a path
// would be written nowhere while config.yaml claimed a key was configured.
func TestPodSpec_ValidateSkillEnvFileContent(t *testing.T) {
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFileContent = "OPENAI_API_KEY=x"
	if err := spec.Validate(); err == nil {
		t.Fatal("Validate accepted skill env content without a file path")
	}
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	if err := spec.Validate(); err != nil {
		t.Fatalf("Validate rejected content with a valid path: %v", err)
	}
	spec.SkillEnvFileContent = "a\x00b"
	if err := spec.Validate(); err == nil {
		t.Fatal("Validate accepted a NUL byte in skill env content")
	}
	spec.SkillEnvFileContent = strings.Repeat("x", MaxSkillEnvFileContentBytes+1)
	if err := spec.Validate(); err == nil {
		t.Fatal("Validate accepted skill env content over the size cap")
	}
}

// Provisioning a Pod with inline content must not be reported as failed just
// because the restart patch could not be issued: the Deployment was written with
// the fresh payload, so there is no stale Pod to bounce. Regression guard for a
// create that returned an error (leaving the Pod in state "error") purely
// because the ServiceAccount lacked `patch` on deployments.
func TestK8s_CreateWithContentDoesNotRestart(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	spec.SkillEnvFileContent = "OPENAI_API_KEY=abc"
	var restarts int
	d.client.(*fake.Clientset).PrependReactor("patch", "deployments", func(k8stesting.Action) (bool, runtime.Object, error) {
		restarts++
		return true, nil, nil
	})
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if restarts != 0 {
		t.Fatalf("first Create issued %d deployment patches, want none", restarts)
	}
}

// A payload change on an existing Pod still has to bounce it, since the mounted
// Secret of a running container is never refreshed.
func TestK8s_CreateWithChangedContentRestarts(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	spec.SkillEnvFileContent = "OPENAI_API_KEY=first"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	var restarts int
	d.client.(*fake.Clientset).PrependReactor("patch", "deployments", func(k8stesting.Action) (bool, runtime.Object, error) {
		restarts++
		return true, nil, nil
	})
	spec.SkillEnvFileContent = "OPENAI_API_KEY=second"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("redeploy: %v", err)
	}
	if restarts != 1 {
		t.Fatalf("changed payload issued %d deployment patches, want exactly 1", restarts)
	}
}

// The cap is duplicated in the config package (which cannot import driver) and
// here. They must agree, or a value accepted at startup would be rejected at Pod
// creation time.
func TestSkillEnvFileContentCapMatchesConfig(t *testing.T) {
	if MaxSkillEnvFileContentBytes != 64*1024 {
		t.Fatalf("driver cap = %d, want 65536 to match maxSkillEnvFileContentBytes", MaxSkillEnvFileContentBytes)
	}
}

// Docker bind-mounts a host file and has nowhere to write inline content, so
// accepting it would leave the container reading a different file than the one
// config.yaml described.
func TestDocker_RejectsSkillEnvFileContent(t *testing.T) {
	d := &DockerDriver{secretDir: t.TempDir(), skillsDir: t.TempDir()}
	spec := dockerTestPodSpec("pod-a", "token")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	spec.SkillEnvHostFile = "/etc/muad/.env.ppt"
	spec.SkillEnvFileContent = "OPENAI_API_KEY=x"
	if err := d.validateSkillEnvFile(spec); err == nil {
		t.Fatal("docker accepted inline skill env content")
	}
}

// The traversal rejection must reach both drivers, not just PodSpec.Validate:
// Create is the path that actually writes the Deployment.
func TestK8s_CreateRejectsTraversalSkillEnvFile(t *testing.T) {
	d := newFakeK8s(t)
	spec := fileRuntimeSpec(t, "alice")
	spec.SkillEnvFile = "/opt/openclaw-secret/../run/secrets/muad/.env.ppt"
	if err := d.Create(context.Background(), spec); err == nil {
		t.Fatal("Create accepted a Skill env path that traverses into the service-token mount")
	}
}

// Overlapping mounts make K8s reject the Deployment (duplicate mountPath) or
// leave the container in CreateContainerConfigError, and the Pod never starts,
// so every overlap must fail at apply time. Covers exact equality with a mount,
// nesting under a configurable mount, and the runtime-config mount that
// deploymentVolumes does not report.
func TestK8s_SkillEnvFileRejectsOverlappingMountDir(t *testing.T) {
	for _, file := range []string{
		"/run/secrets/muad/.env.ppt",                 // equal to service-token mount
		"/opt/openclaw-skills/.env.ppt",              // equal to public skills mount
		"/home/node/.openclaw/skill-secret/.env.ppt", // nested under state dir
		RuntimeConfigDirectory + "/.env.ppt",         // runtime-config mount
	} {
		d := newFakeK8s(t)
		spec := testPodSpec("alice", "img:1")
		spec.SkillEnvFile = file
		// File mode (Version != 0) is when the runtime-config mount is added.
		spec.MultiUser.Version = RuntimeConfigVersion
		if err := d.validateSkillEnvMount(spec); err == nil {
			t.Fatalf("Skill env dir %q accepted despite overlapping another mount", file)
		}
	}
}

// The helper above must actually be wired into the user-facing path.
func TestK8s_CreateRejectsOverlappingSkillEnvDir(t *testing.T) {
	d := newFakeK8s(t)
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/run/secrets/muad/.env.ppt"
	if err := d.Create(context.Background(), spec); err == nil {
		t.Fatal("Create accepted a Skill env dir overlapping the service-token mount")
	}
}

// ReplaceRuntime rolls the workload onto a new runtime config without a
// create gap, so it must apply the same spec validation as Create: otherwise a
// mismatched PodID silently deploys a Pod whose env and runtime.json disagree.
func TestK8s_ReplaceRuntimeValidatesSpec(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	// Version stays non-zero, so PodSpec.Validate() is in play; the runtime PodID
	// no longer matches the workload the spec describes.
	spec.MultiUser.PodID = "bob"
	err := d.ReplaceRuntime(ctx, spec)
	if !errors.Is(err, ErrInvalidPodSpec) {
		t.Fatalf("ReplaceRuntime error = %v, want ErrInvalidPodSpec", err)
	}
}

// A same-name replace must still succeed, proving the validation did not turn
// into an unconditional rejection.
func TestK8s_ReplaceRuntimeAcceptsMatchingSpec(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	spec.ImageTag = "worker:file-v2"
	if err := d.ReplaceRuntime(ctx, spec); err != nil {
		t.Fatalf("ReplaceRuntime on a valid spec: %v", err)
	}
	dep, err := d.client.AppsV1().Deployments(d.namespace).Get(ctx, ContainerName(spec.PodID), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	if got := dep.Spec.Template.Spec.Containers[0].Image; got != spec.ImageTag {
		t.Fatalf("deployment image = %q, want %q", got, spec.ImageTag)
	}
}

func envValue(env []corev1.EnvVar, name string) string {
	for _, item := range env {
		if item.Name == name {
			return item.Value
		}
	}
	return ""
}

func hasVolume(volumes []corev1.Volume, name, secretName string) bool {
	for _, volume := range volumes {
		if volume.Name == name && volume.Secret != nil && volume.Secret.SecretName == secretName {
			return true
		}
	}
	return false
}

func TestK8s_RemoveDeletesSkillEnvSecret(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := testPodSpec("alice", "img:1")
	spec.SkillEnvFile = "/opt/openclaw-secret/.env.ppt"
	if err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := d.Remove(ctx, "alice", false); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-skill-env", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("skill env Secret should be deleted, err = %v", err)
	}
}
