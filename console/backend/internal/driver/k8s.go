package driver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/remotecommand"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
)

// K8sDriver runs each multi-user Pod as a single-replica Deployment in one
// namespace, with a per-Pod PVC, runtime env Secret, service-token Secret, and
// shared read-only skills PVC. The console reaches workers via the k8s API
// (exec/logs); workers expose no Service (channels are outbound).
//
// Note on restart policy: a Deployment always restarts its Pod; the per-user
// "restartPolicy" knob (a docker concept) is not applied here — Stop = scale to 0.
type K8sDriver struct {
	client             kubernetes.Interface
	metrics            metricsv.Interface
	restConfig         *rest.Config // for exec; nil in unit tests
	namespace          string
	skillsPVC          string // shared RWX claim name, mounted read-only (optional)
	skillsStorageClass string
	skillsSize         string
	runtime            RuntimeOptions
	storageClass       string // for per-user state PVC (optional → cluster default)
	stateSize          string // per-Pod state PVC size, e.g. "5Gi"
}

// K8sOptions configures the cluster driver.
type K8sOptions struct {
	Namespace          string
	SkillsPVC          string
	SkillsStorageClass string
	SkillsSize         string
	Runtime            RuntimeOptions
	StorageClass       string
	StateSize          string
}

// NewK8sDriver builds a cluster driver from in-cluster config, falling back to
// the local kubeconfig (KUBECONFIG / ~/.kube/config) for out-of-cluster use.
func NewK8sDriver(o K8sOptions) (*K8sDriver, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{}).ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("k8s: no in-cluster or kubeconfig: %w", err)
		}
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("k8s: clientset: %w", err)
	}
	mc, err := metricsv.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("k8s: metrics client: %w", err)
	}
	ns := o.Namespace
	if ns == "" {
		ns = "muad"
	}
	size := o.StateSize
	if size == "" {
		size = "5Gi"
	}
	skillsSize := o.SkillsSize
	if skillsSize == "" {
		skillsSize = "5Gi"
	}
	return &K8sDriver{
		client: cs, metrics: mc, restConfig: cfg,
		namespace: ns, skillsPVC: o.SkillsPVC, skillsStorageClass: o.SkillsStorageClass,
		skillsSize: skillsSize, runtime: o.Runtime.withDefaults(),
		storageClass: o.StorageClass, stateSize: size,
	}, nil
}

func ptr[T any](v T) *T { return &v }

func (d *K8sDriver) labels(podID string) map[string]string {
	return map[string]string{"app": "muad-oc", "muad-pod": podID}
}

// Create provisions the per-Pod PVC, Secrets, and Deployment.
func (d *K8sDriver) Create(ctx context.Context, spec PodSpec) error {
	if !podIDPattern.MatchString(spec.PodID) || strings.TrimSpace(spec.ImageTag) == "" {
		return ErrInvalidPodSpec
	}
	if spec.MultiUser.Version != 0 {
		if err := spec.Validate(); err != nil {
			return err
		}
	}
	name := ContainerName(spec.PodID)
	if err := d.ensureStatePVC(ctx, spec.PodID, spec.AdoptState); err != nil {
		return err
	}
	if err := d.upsertEnvSecret(ctx, spec); err != nil {
		return err
	}
	if err := d.upsertServiceTokenSecret(ctx, spec); err != nil {
		return err
	}
	return d.upsertDeployment(ctx, spec, name)
}

func (d *K8sDriver) ensureStatePVC(ctx context.Context, podID string, adopt bool) error {
	name := ContainerName(podID) + "-state"
	api := d.client.CoreV1().PersistentVolumeClaims(d.namespace)
	if pvc, err := api.Get(ctx, name, metav1.GetOptions{}); err == nil {
		if pvc.Annotations["muad/state-retained"] == "true" && !adopt {
			return ErrRetainedState
		}
		if adopt && pvc.Annotations["muad/state-retained"] == "true" {
			return d.markPVCRetained(ctx, name, false)
		}
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	qty, err := resource.ParseQuantity(d.stateSize)
	if err != nil {
		return fmt.Errorf("k8s: state size %q: %w", d.stateSize, err)
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: d.namespace, Labels: d.labels(podID),
			Annotations: map[string]string{"muad/state-retained": "false"},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources:   corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: qty}},
		},
	}
	if d.storageClass != "" {
		pvc.Spec.StorageClassName = ptr(d.storageClass)
	}
	_, err = api.Create(ctx, pvc, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (d *K8sDriver) upsertEnvSecret(ctx context.Context, spec PodSpec) error {
	name := ContainerName(spec.PodID) + "-env"
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(spec.PodID)},
		StringData: BuildEnv(spec),
	}
	return d.upsertSecret(ctx, sec)
}

func (d *K8sDriver) upsertServiceTokenSecret(ctx context.Context, spec PodSpec) error {
	if spec.ServiceToken.Value == "" {
		return nil
	}
	name := ContainerName(spec.PodID) + "-service-token"
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(spec.PodID)},
		StringData: map[string]string{"pod-service-token": spec.ServiceToken.Value},
	}
	return d.upsertSecret(ctx, sec)
}

func (d *K8sDriver) upsertSecret(ctx context.Context, desired *corev1.Secret) error {
	api := d.client.CoreV1().Secrets(d.namespace)
	current, err := api.Get(ctx, desired.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = api.Create(ctx, desired, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return err
	}
	desired.ResourceVersion = current.ResourceVersion
	_, err = api.Update(ctx, desired, metav1.UpdateOptions{})
	return err
}

// UpdateSpec rewrites the per-Pod Secrets so the next rollout boots from the
// latest desired Runtime DTO and service-token material.
//
// If the secret already exists, the existing OPENCLAW_GATEWAY_TOKEN is
// preserved (re-using the caller's gatewayToken would rotate the token and
// kick the user's already-connected wecom bot / wechat session offline).
func (d *K8sDriver) UpdateSpec(ctx context.Context, podID string, spec PodSpec) error {
	if podID != spec.PodID {
		return ErrInvalidPodSpec
	}
	name := ContainerName(podID) + "-env"
	api := d.client.CoreV1().Secrets(d.namespace)
	// Preserve existing gateway token if the secret already exists.
	token := spec.GatewayToken
	if cur, err := api.Get(ctx, name, metav1.GetOptions{}); err == nil {
		if t, ok := cur.Data["OPENCLAW_GATEWAY_TOKEN"]; ok && len(t) > 0 {
			token = string(t)
		} else if t := cur.StringData["OPENCLAW_GATEWAY_TOKEN"]; t != "" {
			token = t
		}
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(podID)},
	}
	spec.GatewayToken = token
	sec.StringData = BuildEnv(spec)
	if err := d.upsertSecret(ctx, sec); err != nil {
		return err
	}
	return d.upsertServiceTokenSecret(ctx, spec)
}

func (d *K8sDriver) UpdateServiceToken(ctx context.Context, podID string, secret SecretFileSpec) error {
	if !podIDPattern.MatchString(podID) || secret.ContainerPath != PodServiceTokenPath || secret.Value == "" {
		return ErrInvalidPodSpec
	}
	return d.upsertServiceTokenSecret(ctx, PodSpec{PodID: podID, ServiceToken: secret})
}

func (d *K8sDriver) upsertDeployment(ctx context.Context, spec PodSpec, name string) error {
	dep := d.deployment(spec, name)
	api := d.client.AppsV1().Deployments(d.namespace)
	if _, err := api.Create(ctx, dep, metav1.CreateOptions{}); apierrors.IsAlreadyExists(err) {
		cur, gerr := api.Get(ctx, name, metav1.GetOptions{})
		if gerr != nil {
			return gerr
		}
		dep.ResourceVersion = cur.ResourceVersion
		_, err = api.Update(ctx, dep, metav1.UpdateOptions{})
		return err
	} else {
		return err
	}
}

func (d *K8sDriver) deployment(spec PodSpec, name string) *appsv1.Deployment {
	runtime := d.runtime.withDefaults()
	vols := []corev1.Volume{{
		Name:         "state",
		VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: name + "-state"}},
	}}
	mounts := []corev1.VolumeMount{{Name: "state", MountPath: runtime.StateDir}}
	initContainers := []corev1.Container{}
	if spec.ServiceToken.Value != "" {
		vols = append(vols, serviceTokenVolumes(name)...)
		mounts = append(mounts, corev1.VolumeMount{
			Name: "service-token-runtime", MountPath: "/run/secrets/muad", ReadOnly: true,
		})
		initContainers = append(initContainers, serviceTokenInitContainer(spec))
	}
	if d.skillsPVC != "" {
		vols = append(vols, publicSkillsVolume(d.skillsPVC))
		mounts = append(mounts, d.publicSkillsVolumeMount())
	}
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(spec.PodID)},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr(int32(1)),
			Selector: &metav1.LabelSelector{MatchLabels: d.labels(spec.PodID)},
			// Recreate (not RollingUpdate): a wecom bot allows only one live
			// connection; never run old+new pods at once or they mutually kick.
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: d.labels(spec.PodID)},
				Spec: corev1.PodSpec{
					Volumes:        vols,
					InitContainers: initContainers,
					Containers: []corev1.Container{{
						Name:            "openclaw",
						Image:           spec.ImageTag,
						ImagePullPolicy: corev1.PullIfNotPresent,
						EnvFrom:         []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: name + "-env"}}}},
						Env: []corev1.EnvVar{
							{Name: "TZ", Value: runtime.Timezone},
							{Name: "OPENCLAW_STATE_DIR", Value: runtime.StateDir},
						},
						Ports:        []corev1.ContainerPort{{ContainerPort: GatewayPort}},
						VolumeMounts: mounts,
						Resources:    resourceReqs(spec),
					}},
				},
			},
		},
	}
}

func publicSkillsVolume(claimName string) corev1.Volume {
	return corev1.Volume{
		Name: "skills",
		VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
				ClaimName: claimName,
				ReadOnly:  true,
			},
		},
	}
}

func (d *K8sDriver) publicSkillsVolumeMount() corev1.VolumeMount {
	return corev1.VolumeMount{
		Name:      "skills",
		MountPath: d.runtime.withDefaults().PublicSkillsDir,
		ReadOnly:  true,
	}
}

func (d *K8sDriver) scale(ctx context.Context, podID string, n int32) error {
	name := ContainerName(podID)
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, n))
	_, err := d.client.AppsV1().Deployments(d.namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

func (d *K8sDriver) Start(ctx context.Context, podID string) error  { return d.scale(ctx, podID, 1) }
func (d *K8sDriver) Stop(ctx context.Context, podID string) error   { return d.scale(ctx, podID, 0) }
func (d *K8sDriver) Reap(ctx context.Context, podID string) error   { return d.scale(ctx, podID, 0) }
func (d *K8sDriver) Revive(ctx context.Context, podID string) error { return d.scale(ctx, podID, 1) }

// Restart triggers a rollout by bumping a template annotation.
func (d *K8sDriver) Restart(ctx context.Context, podID string) error {
	name := ContainerName(podID)
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"muad/restartedAt":%q}}}}}`,
		time.Now().Format(time.RFC3339)))
	_, err := d.client.AppsV1().Deployments(d.namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

// Remove deletes the Deployment + Secret; when !keepState the state PVC too.
// Idempotent: NotFound is tolerated so orphaned records can still be cleaned up.
func (d *K8sDriver) Remove(ctx context.Context, podID string, keepState bool) error {
	name := ContainerName(podID)
	if err := d.client.AppsV1().Deployments(d.namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := d.client.CoreV1().Secrets(d.namespace).Delete(ctx, name+"-env", metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := d.client.CoreV1().Secrets(d.namespace).Delete(ctx, name+"-service-token", metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if keepState {
		if err := d.markPVCRetained(ctx, name+"-state", true); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	} else {
		if err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Delete(ctx, name+"-state", metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func (d *K8sDriver) markPVCRetained(ctx context.Context, name string, retained bool) error {
	value := "false"
	if retained {
		value = "true"
	}
	patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{"muad/state-retained":%q}}}`, value))
	_, err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Patch(
		ctx, name, types.MergePatchType, patch, metav1.PatchOptions{},
	)
	return err
}

// List returns all muad-oc-* worker Deployments with a normalized state.
func (d *K8sDriver) List(ctx context.Context) ([]ContainerInfo, error) {
	deps, err := d.client.AppsV1().Deployments(d.namespace).List(ctx, metav1.ListOptions{LabelSelector: "app=muad-oc"})
	if err != nil {
		return nil, err
	}
	var out []ContainerInfo
	for i := range deps.Items {
		dep := &deps.Items[i]
		podID := dep.Labels["muad-pod"]
		if podID == "" {
			podID = strings.TrimPrefix(dep.Name, "muad-oc-")
		}
		img := ""
		if cs := dep.Spec.Template.Spec.Containers; len(cs) > 0 {
			img = cs[0].Image
		}
		var rep int32
		if dep.Spec.Replicas != nil {
			rep = *dep.Spec.Replicas
		}
		state := "creating"
		if rep == 0 {
			state = "stopped"
		} else if dep.Status.AvailableReplicas >= 1 {
			state = "running"
		}
		out = append(out, ContainerInfo{PodID: podID, UserID: podID, State: state, ImageTag: img})
	}
	return out, nil
}

// StatsAll sums CPU/MEM from metrics-server for every worker pod.
func (d *K8sDriver) StatsAll(ctx context.Context) (map[string]Stats, error) {
	list, err := d.metrics.MetricsV1beta1().PodMetricses(d.namespace).List(ctx, metav1.ListOptions{LabelSelector: "app=muad-oc"})
	if err != nil {
		return nil, err
	}
	out := map[string]Stats{}
	for i := range list.Items {
		pm := &list.Items[i]
		podID := pm.Labels["muad-pod"]
		if podID == "" {
			continue
		}
		var milliCPU, memBytes int64
		for _, c := range pm.Containers {
			milliCPU += c.Usage.Cpu().MilliValue()
			memBytes += c.Usage.Memory().Value()
		}
		out[podID] = Stats{CPUPercent: float64(milliCPU) / 10.0, MemMiB: int(memBytes / 1024 / 1024)}
	}
	return out, nil
}

// Logs returns the worker pod's last `tail` log lines.
func (d *K8sDriver) Logs(ctx context.Context, podID string, tail int) (string, error) {
	pod, err := d.podName(ctx, podID)
	if err != nil {
		return "", err
	}
	t := int64(tail)
	req := d.client.CoreV1().Pods(d.namespace).GetLogs(pod, &corev1.PodLogOptions{TailLines: &t})
	rc, err := req.Stream(ctx)
	if err != nil {
		return "", err
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	return string(b), err
}

// Exec runs a command in the worker Pod and returns combined stdout.
// ExecStdin runs a command in the worker pod with stdin piped from the reader.
func (d *K8sDriver) ExecStdin(ctx context.Context, podID string, stdin io.Reader, cmd ...string) (string, error) {
	if d.restConfig == nil {
		return "", fmt.Errorf("k8s: exec unavailable (no rest config)")
	}
	pod, err := d.podName(ctx, podID)
	if err != nil {
		return "", err
	}
	return d.execStdinInPod(ctx, pod, stdin, cmd...)
}

func (d *K8sDriver) execStdinInPod(ctx context.Context, pod string, stdin io.Reader, cmd ...string) (string, error) {
	if d.restConfig == nil {
		return "", fmt.Errorf("k8s: exec unavailable (no rest config)")
	}
	req := d.client.CoreV1().RESTClient().Post().
		Resource("pods").Name(pod).Namespace(d.namespace).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Command: cmd, Stdout: true, Stderr: true, Stdin: true,
		}, scheme.ParameterCodec)
	exec, err := remotecommand.NewSPDYExecutor(d.restConfig, "POST", req.URL())
	if err != nil {
		return "", err
	}
	var stdout, stderr bytes.Buffer
	if err := exec.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &stdout, Stderr: &stderr, Stdin: stdin}); err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func (d *K8sDriver) Exec(ctx context.Context, podID string, cmd ...string) (string, error) {
	if d.restConfig == nil {
		return "", fmt.Errorf("k8s: exec unavailable (no rest config)")
	}
	pod, err := d.podName(ctx, podID)
	if err != nil {
		return "", err
	}
	req := d.client.CoreV1().RESTClient().Post().
		Resource("pods").Name(pod).Namespace(d.namespace).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Command: cmd, Stdout: true, Stderr: true,
		}, scheme.ParameterCodec)
	exec, err := remotecommand.NewSPDYExecutor(d.restConfig, "POST", req.URL())
	if err != nil {
		return "", err
	}
	var stdout, stderr bytes.Buffer
	if err := exec.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &stdout, Stderr: &stderr}); err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// podName returns a running worker Pod or a retryable readiness error.
func (d *K8sDriver) podName(ctx context.Context, podID string) (string, error) {
	pods, err := d.client.CoreV1().Pods(d.namespace).List(ctx, metav1.ListOptions{LabelSelector: "muad-pod=" + podID})
	if err != nil {
		return "", err
	}
	for i := range pods.Items {
		if pods.Items[i].Status.Phase == corev1.PodRunning {
			return pods.Items[i].Name, nil
		}
	}
	if len(pods.Items) > 0 {
		pod := pods.Items[0]
		return "", fmt.Errorf("%w: Pod %s phase=%s", ErrRuntimeNotReady, pod.Name, pod.Status.Phase)
	}
	return "", fmt.Errorf("%w: no workload Pod for %q", ErrRuntimeNotReady, podID)
}
