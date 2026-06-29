package driver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"

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

// K8sDriver runs each user's openclaw worker as a single-replica Deployment in
// one namespace, with a per-user PVC (state) + Secret (env) and an optional
// shared read-only skills PVC. The console reaches workers via the k8s API
// (exec/logs); workers expose no Service (channels are outbound).
//
// Note on restart policy: a Deployment always restarts its Pod; the per-user
// "restartPolicy" knob (a docker concept) is not applied here — Stop = scale to 0.
type K8sDriver struct {
	client       kubernetes.Interface
	metrics      metricsv.Interface
	restConfig   *rest.Config // for exec; nil in unit tests
	namespace    string
	skillsPVC    string // shared RWX claim name, mounted read-only (optional)
	storageClass string // for per-user state PVC (optional → cluster default)
	stateSize    string // per-user state PVC size, e.g. "5Gi"
}

// K8sOptions configures the cluster driver.
type K8sOptions struct {
	Namespace    string
	SkillsPVC    string
	StorageClass string
	StateSize    string
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
	return &K8sDriver{
		client: cs, metrics: mc, restConfig: cfg,
		namespace: ns, skillsPVC: o.SkillsPVC, storageClass: o.StorageClass, stateSize: size,
	}, nil
}

func ptr[T any](v T) *T { return &v }

func (d *K8sDriver) labels(userID string) map[string]string {
	return map[string]string{"app": "muad-oc", "muad-user": userID}
}

// Create provisions the per-user PVC + Secret + Deployment (idempotent upsert).
func (d *K8sDriver) Create(ctx context.Context, spec UserSpec, gatewayToken string) error {
	name := ContainerName(spec.UserID)
	if err := d.ensureStatePVC(ctx, spec.UserID); err != nil {
		return err
	}
	if err := d.upsertSecret(ctx, spec, gatewayToken); err != nil {
		return err
	}
	return d.upsertDeployment(ctx, spec, name)
}

func (d *K8sDriver) ensureStatePVC(ctx context.Context, userID string) error {
	name := ContainerName(userID) + "-state"
	if _, err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Get(ctx, name, metav1.GetOptions{}); err == nil {
		return nil // already exists; keep state
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	qty, err := resource.ParseQuantity(d.stateSize)
	if err != nil {
		return fmt.Errorf("k8s: state size %q: %w", d.stateSize, err)
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(userID)},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources:   corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: qty}},
		},
	}
	if d.storageClass != "" {
		pvc.Spec.StorageClassName = ptr(d.storageClass)
	}
	_, err = d.client.CoreV1().PersistentVolumeClaims(d.namespace).Create(ctx, pvc, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (d *K8sDriver) upsertSecret(ctx context.Context, spec UserSpec, gatewayToken string) error {
	name := ContainerName(spec.UserID) + "-env"
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(spec.UserID)},
		StringData: BuildEnv(spec, gatewayToken),
	}
	api := d.client.CoreV1().Secrets(d.namespace)
	if _, err := api.Create(ctx, sec, metav1.CreateOptions{}); apierrors.IsAlreadyExists(err) {
		_, err = api.Update(ctx, sec, metav1.UpdateOptions{})
		return err
	} else {
		return err
	}
}

func (d *K8sDriver) upsertDeployment(ctx context.Context, spec UserSpec, name string) error {
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

func (d *K8sDriver) deployment(spec UserSpec, name string) *appsv1.Deployment {
	vols := []corev1.Volume{{
		Name:         "state",
		VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: name + "-state"}},
	}}
	mounts := []corev1.VolumeMount{{Name: "state", MountPath: "/home/node/.openclaw"}}
	if d.skillsPVC != "" {
		vols = append(vols, corev1.Volume{
			Name:         "skills",
			VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: d.skillsPVC, ReadOnly: true}},
		})
		mounts = append(mounts, corev1.VolumeMount{Name: "skills", MountPath: "/opt/openclaw-skills", ReadOnly: true})
	}
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: d.labels(spec.UserID)},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr(int32(1)),
			Selector: &metav1.LabelSelector{MatchLabels: d.labels(spec.UserID)},
			// Recreate (not RollingUpdate): a wecom bot allows only one live
			// connection; never run old+new pods at once or they mutually kick.
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: d.labels(spec.UserID)},
				Spec: corev1.PodSpec{
					Volumes: vols,
					Containers: []corev1.Container{{
						Name:    "openclaw",
						Image:   spec.ImageTag,
						EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: name + "-env"}}}},
						Env: []corev1.EnvVar{
							{Name: "TZ", Value: "Asia/Shanghai"},
							{Name: "OPENCLAW_STATE_DIR", Value: "/home/node/.openclaw"},
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

// resourceReqs maps the resolved limits to k8s requests/limits. requests are a
// conservative idle baseline; limits come from the per-user/global config.
func resourceReqs(spec UserSpec) corev1.ResourceRequirements {
	req := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("100m"),
		corev1.ResourceMemory: resource.MustParse("512Mi"),
	}
	lim := corev1.ResourceList{}
	if q, err := resource.ParseQuantity(orDefault(spec.CPULimit, DefaultCPULimit)); err == nil {
		lim[corev1.ResourceCPU] = q
	}
	if m := toK8sMem(orDefault(spec.MemLimit, DefaultMemLimit)); m != "" {
		if q, err := resource.ParseQuantity(m); err == nil {
			lim[corev1.ResourceMemory] = q
		}
	}
	return corev1.ResourceRequirements{Requests: req, Limits: lim}
}

// toK8sMem converts a docker memory string (binary units b/k/m/g) to a k8s
// quantity (Ki/Mi/Gi). "2g" → "2Gi", "512m" → "512Mi".
func toK8sMem(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	switch unicode.ToLower(rune(s[len(s)-1])) {
	case 'g':
		return s[:len(s)-1] + "Gi"
	case 'm':
		return s[:len(s)-1] + "Mi"
	case 'k':
		return s[:len(s)-1] + "Ki"
	case 'b':
		return s[:len(s)-1]
	default:
		return s // assume bytes
	}
}

func (d *K8sDriver) scale(ctx context.Context, userID string, n int32) error {
	name := ContainerName(userID)
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, n))
	_, err := d.client.AppsV1().Deployments(d.namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

func (d *K8sDriver) Start(ctx context.Context, userID string) error  { return d.scale(ctx, userID, 1) }
func (d *K8sDriver) Stop(ctx context.Context, userID string) error   { return d.scale(ctx, userID, 0) }
func (d *K8sDriver) Reap(ctx context.Context, userID string) error   { return d.scale(ctx, userID, 0) }
func (d *K8sDriver) Revive(ctx context.Context, userID string) error { return d.scale(ctx, userID, 1) }

// Restart triggers a rollout by bumping a template annotation.
func (d *K8sDriver) Restart(ctx context.Context, userID string) error {
	name := ContainerName(userID)
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"muad/restartedAt":%q}}}}}`,
		time.Now().Format(time.RFC3339)))
	_, err := d.client.AppsV1().Deployments(d.namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

// Remove deletes the Deployment + Secret; when !keepState the state PVC too.
// Idempotent: NotFound is tolerated so orphaned records can still be cleaned up.
func (d *K8sDriver) Remove(ctx context.Context, userID string, keepState bool) error {
	name := ContainerName(userID)
	if err := d.client.AppsV1().Deployments(d.namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := d.client.CoreV1().Secrets(d.namespace).Delete(ctx, name+"-env", metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if !keepState {
		if err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Delete(ctx, name+"-state", metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
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
		user := dep.Labels["muad-user"]
		if user == "" {
			user = strings.TrimPrefix(dep.Name, "muad-oc-")
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
		out = append(out, ContainerInfo{UserID: user, State: state, ImageTag: img})
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
		user := pm.Labels["muad-user"]
		if user == "" {
			continue
		}
		var milliCPU, memBytes int64
		for _, c := range pm.Containers {
			milliCPU += c.Usage.Cpu().MilliValue()
			memBytes += c.Usage.Memory().Value()
		}
		out[user] = Stats{CPUPercent: float64(milliCPU) / 10.0, MemMiB: int(memBytes / 1024 / 1024)}
	}
	return out, nil
}

// Logs returns the worker pod's last `tail` log lines.
func (d *K8sDriver) Logs(ctx context.Context, userID string, tail int) (string, error) {
	pod, err := d.podName(ctx, userID)
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

// Exec runs a command in the worker pod and returns combined stdout.
func (d *K8sDriver) Exec(ctx context.Context, userID string, cmd ...string) (string, error) {
	if d.restConfig == nil {
		return "", fmt.Errorf("k8s: exec unavailable (no rest config)")
	}
	pod, err := d.podName(ctx, userID)
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

// podName returns a running worker pod for the user (newest first).
func (d *K8sDriver) podName(ctx context.Context, userID string) (string, error) {
	pods, err := d.client.CoreV1().Pods(d.namespace).List(ctx, metav1.ListOptions{LabelSelector: "muad-user=" + userID})
	if err != nil {
		return "", err
	}
	for i := range pods.Items {
		if pods.Items[i].Status.Phase == corev1.PodRunning {
			return pods.Items[i].Name, nil
		}
	}
	if len(pods.Items) > 0 {
		return pods.Items[0].Name, nil
	}
	return "", fmt.Errorf("k8s: no pod for user %q", userID)
}
