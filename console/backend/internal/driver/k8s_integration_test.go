//go:build integration

package driver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const integrationTransactionScript = "/opt/muad/runtime-config-transaction.mjs"

func TestK8sIntegration_SecretRuntimeAndRetainedPVC(t *testing.T) {
	image := os.Getenv("MUAD_K8S_TEST_IMAGE")
	if image == "" {
		t.Skip("MUAD_K8S_TEST_IMAGE is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	driver, err := NewK8sDriver(K8sOptions{
		Namespace: "muad", StorageClass: "local-path", StateSize: "1Gi",
	})
	if err != nil {
		t.Fatalf("NewK8sDriver: %v", err)
	}
	podID := fmt.Sprintf("contract-k8s-%d", time.Now().Unix()%1_000_000)
	spec, runtime := integrationK8sSpec(t, podID, image)
	defer func() { _ = driver.Remove(context.Background(), podID, false) }()

	podName := createK8sWorkload(t, ctx, driver, spec, "")
	assertK8sTokenMount(t, ctx, driver, podID)
	podName = rotateK8sToken(t, ctx, driver, spec, podName)
	applyK8sGeneration(t, ctx, driver, podID, &runtime, 8)
	spec.MultiUser, spec.ServiceToken.Value = runtime, "token-two"
	if err := driver.UpdateSpec(ctx, podID, spec); err != nil {
		t.Fatalf("UpdateSpec: %v", err)
	}
	if err := driver.Restart(ctx, podID); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	waitK8sPod(t, ctx, driver, podID, podName)
	waitK8sGeneration(t, ctx, driver, podID, 8)
	assertK8sRetainedLifecycle(t, ctx, driver, spec)
}

func integrationK8sSpec(t *testing.T, podID, image string) (PodSpec, RuntimeConfigV1) {
	t.Helper()
	raw, err := os.ReadFile("../../../../bin/test/fixtures/runtime-v1.json")
	if err != nil {
		t.Fatalf("read Runtime fixture: %v", err)
	}
	var runtime RuntimeConfigV1
	if err := json.Unmarshal(raw, &runtime); err != nil {
		t.Fatalf("decode Runtime fixture: %v", err)
	}
	runtime.PodID = podID
	spec := PodSpec{
		PodID: podID, ImageTag: image, Channels: runtime.Channels.Enabled,
		ChannelConfigs: runtime.Channels.Configs, GatewayToken: "k8s-contract-gateway",
		MultiUser: runtime, ServiceToken: integrationSecret("token-one"),
		Resource: ResourceSpec{
			MemLimit: "2g", CPULimit: "1", RestartPolicy: "always",
			MaxSkillConcurrency: 2, MaxBrowserConcurrency: 1,
		},
	}
	if err := spec.Validate(); err != nil {
		t.Fatalf("integration PodSpec: %v", err)
	}
	return spec, runtime
}

func createK8sWorkload(
	t *testing.T, ctx context.Context, driver *K8sDriver, spec PodSpec, previous string,
) string {
	t.Helper()
	if err := driver.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	name := waitK8sPod(t, ctx, driver, spec.PodID, previous)
	waitK8sGeneration(t, ctx, driver, spec.PodID, spec.MultiUser.Generation)
	return name
}

func assertK8sTokenMount(t *testing.T, ctx context.Context, driver *K8sDriver, podID string) {
	t.Helper()
	out, err := driver.Exec(ctx, podID, "stat", "-c", "%a %u:%g", PodServiceTokenPath)
	if err != nil || strings.TrimSpace(out) != "400 1000:1000" {
		t.Fatalf("service token mode/owner = %q, %v", out, err)
	}
	out, err = driver.Exec(ctx, podID, "sh", "-c",
		`if env | grep -q 'MUAD_POD_SERVICE_TOKEN\|token-one'; then exit 1; fi; echo absent`)
	if err != nil || strings.TrimSpace(out) != "absent" {
		t.Fatalf("service token env check = %q, %v", out, err)
	}
}

func rotateK8sToken(
	t *testing.T, ctx context.Context, driver *K8sDriver, spec PodSpec, oldPod string,
) string {
	t.Helper()
	before := k8sTokenDigest(t, ctx, driver, spec.PodID)
	if err := driver.UpdateServiceToken(ctx, spec.PodID, integrationSecret("token-two")); err != nil {
		t.Fatalf("UpdateServiceToken: %v", err)
	}
	if current := k8sTokenDigest(t, ctx, driver, spec.PodID); current != before {
		t.Fatal("running Pod token changed before initContainer reran")
	}
	if err := driver.Restart(ctx, spec.PodID); err != nil {
		t.Fatalf("Restart after token update: %v", err)
	}
	name := waitK8sPod(t, ctx, driver, spec.PodID, oldPod)
	if after := k8sTokenDigest(t, ctx, driver, spec.PodID); after == before {
		t.Fatal("service token digest did not change after rollout")
	}
	return name
}

func k8sTokenDigest(t *testing.T, ctx context.Context, driver *K8sDriver, podID string) string {
	t.Helper()
	out, err := driver.Exec(ctx, podID, "sha256sum", PodServiceTokenPath)
	if err != nil {
		t.Fatalf("token digest: %v", err)
	}
	return strings.Fields(out)[0]
}

func applyK8sGeneration(
	t *testing.T, ctx context.Context, driver *K8sDriver, podID string,
	runtime *RuntimeConfigV1, generation int64,
) {
	t.Helper()
	runtime.Generation = generation
	payload, err := json.Marshal(runtime)
	if err != nil {
		t.Fatalf("encode Runtime generation: %v", err)
	}
	if _, err := driver.ExecStdin(ctx, podID, bytes.NewReader(payload),
		"node", integrationTransactionScript, "prepare"); err != nil {
		t.Fatalf("prepare generation: %v", err)
	}
	if _, err := driver.Exec(ctx, podID, "node", integrationTransactionScript, "validate"); err != nil {
		t.Fatalf("validate generation: %v", err)
	}
	if _, err := driver.ExecStdin(ctx, podID, bytes.NewReader(payload),
		"node", integrationTransactionScript, "commit"); err != nil {
		t.Fatalf("commit generation: %v", err)
	}
	if _, err := driver.Exec(ctx, podID, "kill", "-USR1", "1"); err != nil {
		t.Fatalf("signal Gateway: %v", err)
	}
	waitK8sGeneration(t, ctx, driver, podID, generation)
}

func assertK8sRetainedLifecycle(
	t *testing.T, ctx context.Context, driver *K8sDriver, spec PodSpec,
) {
	t.Helper()
	if err := driver.Remove(ctx, spec.PodID, true); err != nil {
		t.Fatalf("Remove retain: %v", err)
	}
	waitK8sDeploymentDeleted(t, ctx, driver, spec.PodID)
	pvc := getK8sPVC(t, ctx, driver, spec.PodID)
	if pvc.Annotations["muad/state-retained"] != "true" {
		t.Fatalf("retained annotation = %v", pvc.Annotations)
	}
	if err := driver.Create(ctx, spec); !errors.Is(err, ErrRetainedState) {
		t.Fatalf("Create retained state error = %v", err)
	}
	spec.AdoptState = true
	createK8sWorkload(t, ctx, driver, spec, "")
	if pvc = getK8sPVC(t, ctx, driver, spec.PodID); pvc.Annotations["muad/state-retained"] != "false" {
		t.Fatalf("adopted annotation = %v", pvc.Annotations)
	}
	if err := driver.Remove(ctx, spec.PodID, false); err != nil {
		t.Fatalf("Remove delete state: %v", err)
	}
	waitK8sPVCDeleted(t, ctx, driver, spec.PodID)
}

func waitK8sPod(
	t *testing.T, ctx context.Context, driver *K8sDriver, podID, previous string,
) string {
	t.Helper()
	for ctx.Err() == nil {
		pods, err := driver.client.CoreV1().Pods(driver.namespace).List(
			ctx, metav1.ListOptions{LabelSelector: "muad-pod=" + podID},
		)
		if err == nil {
			for i := range pods.Items {
				pod := &pods.Items[i]
				if pod.Name != previous && pod.Status.Phase == corev1.PodRunning && podReady(pod) {
					return pod.Name
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("wait Pod %s: %v", podID, ctx.Err())
	return ""
}

func podReady(pod *corev1.Pod) bool {
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady && condition.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func waitK8sGeneration(
	t *testing.T, ctx context.Context, driver *K8sDriver, podID string, expected int64,
) {
	t.Helper()
	for ctx.Err() == nil {
		out, err := driver.Exec(ctx, podID, "openclaw", "gateway", "call", "muad.runtime.health", "--json")
		var health struct {
			OK         bool  `json:"ok"`
			Generation int64 `json:"generation"`
		}
		if err == nil && json.Unmarshal([]byte(out), &health) == nil && health.OK && health.Generation == expected {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("wait generation %d: %v", expected, ctx.Err())
}

func waitK8sDeploymentDeleted(t *testing.T, ctx context.Context, driver *K8sDriver, podID string) {
	t.Helper()
	name := ContainerName(podID)
	for ctx.Err() == nil {
		_, err := driver.client.AppsV1().Deployments(driver.namespace).Get(ctx, name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("wait Deployment deletion: %v", ctx.Err())
}

func getK8sPVC(
	t *testing.T, ctx context.Context, driver *K8sDriver, podID string,
) *corev1.PersistentVolumeClaim {
	t.Helper()
	pvc, err := driver.client.CoreV1().PersistentVolumeClaims(driver.namespace).Get(
		ctx, ContainerName(podID)+"-state", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatalf("get PVC: %v", err)
	}
	return pvc
}

func waitK8sPVCDeleted(t *testing.T, ctx context.Context, driver *K8sDriver, podID string) {
	t.Helper()
	name := ContainerName(podID) + "-state"
	for ctx.Err() == nil {
		_, err := driver.client.CoreV1().PersistentVolumeClaims(driver.namespace).Get(ctx, name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("wait PVC deletion: %v", ctx.Err())
}
