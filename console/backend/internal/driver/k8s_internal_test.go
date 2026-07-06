package driver

import (
	"context"
	"testing"

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
	spec := UserSpec{UserID: "alice", Channels: []string{"wechat"}, ImageTag: "img:1", MemLimit: "3g", CPULimit: "2"}
	if err := d.Create(ctx, spec, "tok"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// PVC + Secret + Deployment exist
	if _, err := d.client.CoreV1().PersistentVolumeClaims("muad").Get(ctx, "muad-oc-alice-state", metav1.GetOptions{}); err != nil {
		t.Errorf("state PVC: %v", err)
	}
	if _, err := d.client.CoreV1().Secrets("muad").Get(ctx, "muad-oc-alice-env", metav1.GetOptions{}); err != nil {
		t.Errorf("env secret: %v", err)
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
}

func TestK8s_StartStopScales(t *testing.T) {
	d := newFakeK8s()
	ctx := context.Background()
	_ = d.Create(ctx, UserSpec{UserID: "bob", ImageTag: "img:1"}, "t")

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
	_ = d.Create(ctx, UserSpec{UserID: "carol", ImageTag: "img:1"}, "t")
	if err := d.Remove(ctx, "carol", true); err != nil {
		t.Fatalf("Remove keepState: %v", err)
	}
	if _, err := d.client.AppsV1().Deployments("muad").Get(ctx, "muad-oc-carol", metav1.GetOptions{}); err == nil {
		t.Error("deployment should be deleted")
	}
	if _, err := d.client.CoreV1().PersistentVolumeClaims("muad").Get(ctx, "muad-oc-carol-state", metav1.GetOptions{}); err != nil {
		t.Error("PVC should be kept when keepState=true")
	}

	// keepState=false → PVC deleted
	d2 := newFakeK8s()
	_ = d2.Create(ctx, UserSpec{UserID: "dave", ImageTag: "img:1"}, "t")
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

func TestK8s_ListMapsState(t *testing.T) {
	d := newFakeK8s()
	ctx := context.Background()
	_ = d.Create(ctx, UserSpec{UserID: "alice", ImageTag: "img:1"}, "t")
	_ = d.Create(ctx, UserSpec{UserID: "bob", ImageTag: "img:2"}, "t")
	_ = d.Stop(ctx, "bob")

	infos, err := d.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := map[string]string{}
	for _, i := range infos {
		got[i.UserID] = i.State
	}
	if got["bob"] != "stopped" {
		t.Errorf("bob state = %q, want stopped", got["bob"])
	}
	// alice: replicas=1 but fake has no AvailableReplicas → "creating"
	if got["alice"] != "creating" && got["alice"] != "running" {
		t.Errorf("alice state = %q", got["alice"])
	}
}

func TestToK8sMem(t *testing.T) {
	cases := map[string]string{"2g": "2Gi", "512m": "512Mi", "3g": "3Gi", "1024k": "1024Ki", "": ""}
	for in, want := range cases {
		if got := toK8sMem(in); got != want {
			t.Errorf("toK8sMem(%q) = %q, want %q", in, got, want)
		}
	}
}
