package driver

import (
	"context"
	"errors"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// newFakeK8s builds a K8sDriver backed by a fake clientset (no real cluster).
func newFakeK8s() *K8sDriver {
	return &K8sDriver{
		client:    fake.NewSimpleClientset(),
		namespace: "muad",
		skillsPVC: "muad-skills",
		stateSize: "5Gi",
	}
}

func TestK8s_CreateProvisionsAll(t *testing.T) {
	d := newFakeK8s()
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
	if len(dep.Spec.Template.Spec.InitContainers) != 1 {
		t.Fatalf("init containers = %d, want 1", len(dep.Spec.Template.Spec.InitContainers))
	}
	if !hasVolumeMount(c.VolumeMounts, "service-token-runtime", "/run/secrets/muad") {
		t.Fatal("main container is missing read-only service-token runtime mount")
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

func TestK8s_EnsurePublicSkillsStorageCreatesRWXPVC(t *testing.T) {
	d := newFakeK8s()
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
	d := newFakeK8s()
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
	d := newFakeK8s()
	err := d.SyncPublicSkills(context.Background(), "pod-a", t.TempDir())
	if !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("SyncPublicSkills without ready PVC = %v, want ErrRuntimeNotReady", err)
	}
}

func TestK8s_EnsurePublicSkillsMountPatchesExistingDeployment(t *testing.T) {
	d := newFakeK8s()
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
}

func TestK8s_EnsurePublicSkillsMountReplacesStaleVolumeAndMount(t *testing.T) {
	d := newFakeK8s()
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
}

func TestK8s_StartStopScales(t *testing.T) {
	d := newFakeK8s()
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
	d := newFakeK8s()
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
	d2 := newFakeK8s()
	_ = d2.Create(ctx, testPodSpec("dave", "img:1"))
	if err := d2.Remove(ctx, "dave", false); err != nil {
		t.Fatalf("Remove deleteVolume: %v", err)
	}
	if _, err := d2.client.CoreV1().PersistentVolumeClaims("muad").Get(ctx, "muad-oc-dave-state", metav1.GetOptions{}); err == nil {
		t.Error("PVC should be deleted when keepState=false")
	}
}

func TestK8s_RemoveIdempotent(t *testing.T) {
	d := newFakeK8s()
	if err := d.Remove(context.Background(), "ghost", false); err != nil {
		t.Errorf("Remove of absent user should be nil, got %v", err)
	}
}

func TestK8s_UpdateSpecRotatesOnlyServiceToken(t *testing.T) {
	d := newFakeK8s()
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
	d := newFakeK8s()
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
	d := newFakeK8s()
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
	d := newFakeK8s()
	if _, err := d.podName(context.Background(), "missing"); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("missing podName error = %v, want ErrRuntimeNotReady", err)
	}
}

func testPodSpec(podID, image string) PodSpec {
	return PodSpec{
		PodID: podID, ImageTag: image, GatewayToken: "gateway-token",
		Resource: ResourceSpec{
			MemLimit: "2g", CPULimit: "1", RestartPolicy: "unless-stopped",
			MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1,
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
