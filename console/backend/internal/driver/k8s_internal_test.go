package driver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
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
	cases := map[string]string{"2g": "2Gi", "512m": "512Mi", "3g": "3Gi", "1024k": "1024Ki", "": ""}
	for in, want := range cases {
		if got := toK8sMem(in); got != want {
			t.Errorf("toK8sMem(%q) = %q, want %q", in, got, want)
		}
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
