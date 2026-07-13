package test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
)

func TestBuildEnv_OmitsLLMEnv(t *testing.T) {
	spec := driver.PodSpec{PodID: "alice", Channels: []string{"wecom"}, ChannelConfigs: map[string]json.RawMessage{"wecom": json.RawMessage(`{"wecom": {"botId": "wb-1", "secret": "s"}}`)}, GatewayToken: "tok"}
	env := driver.BuildEnv(spec)

	if env["MUAD_POD_ID"] != "alice" || env["CHANNELS"] != "wecom" {
		t.Fatalf("missing required identity/channels env: %+v", env)
	}
	if env["CHANNEL_CONFIGS"] == "" {
		t.Fatalf("missing channel configs env: %+v", env)
	}
	if env["OPENCLAW_GATEWAY_TOKEN"] != "tok" {
		t.Errorf("gateway token not set")
	}
	if _, ok := env["LLM_MODEL"]; ok {
		t.Errorf("LLM env should be omitted; runtime config providers carry model credentials")
	}
}

func TestBuildEnv_IncludesSessionManagerConsoleURL(t *testing.T) {
	spec := driver.PodSpec{
		PodID: "pod-a",
		MultiUser: driver.RuntimeConfigV1{
			Version: driver.RuntimeConfigVersion, ConsoleInternalURL: "http://muad-console:8080",
		},
	}
	env := driver.BuildEnv(spec)
	if env["MUAD_CONSOLE_INTERNAL_URL"] != "http://muad-console:8080" || env["MUAD_RUNTIME_CONFIG"] == "" {
		t.Fatalf("session-manager runtime env = %+v", env)
	}
}

func TestContainerName(t *testing.T) {
	if got := driver.ContainerName("alice"); got != "muad-oc-alice" {
		t.Errorf("ContainerName = %q, want muad-oc-alice", got)
	}
}

func TestParseStats(t *testing.T) {
	got, err := driver.ParseStats("12.34%;1.5GiB / 2GiB")
	if err != nil {
		t.Fatalf("ParseStats: %v", err)
	}
	if got.CPUPercent != 12.34 {
		t.Errorf("CPU = %v, want 12.34", got.CPUPercent)
	}
	if got.MemMiB != 1536 {
		t.Errorf("Mem = %d MiB, want 1536", got.MemMiB)
	}
}

func TestParseStats_MiB(t *testing.T) {
	got, err := driver.ParseStats("0.00%;269MiB / 2GiB")
	if err != nil {
		t.Fatalf("ParseStats: %v", err)
	}
	if got.MemMiB != 269 {
		t.Errorf("Mem = %d, want 269", got.MemMiB)
	}
}

func TestParseStats_Bad(t *testing.T) {
	if _, err := driver.ParseStats("garbage"); err == nil {
		t.Error("expected error on malformed stats")
	}
}

func TestMapDockerState(t *testing.T) {
	cases := map[string]string{"running": "running", "exited": "stopped", "created": "creating", "dead": "stopped"}
	for in, want := range cases {
		if got := driver.MapDockerState(in); got != want {
			t.Errorf("MapDockerState(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveResourceSpecAndMemoryLimit(t *testing.T) {
	got := driver.ResolveResourceSpec(
		driver.ResourceSpec{MemLimit: "2.5g", MaxSkillConcurrency: 4},
		driver.ResourceSpec{CPULimit: "2", RestartPolicy: "always"},
		driver.ResourceSpec{MemLimit: "1g", CPULimit: "1", RestartPolicy: "no", MaxSkillConcurrency: 1, MaxBrowserConcurrency: 2},
	)
	if got.MemLimit != "2.5g" || got.CPULimit != "2" || got.MaxSkillConcurrency != 4 || got.MaxBrowserConcurrency != 2 {
		t.Errorf("unexpected effective resources: %+v", got)
	}
	if memory, err := driver.MemoryLimitMiB(got.MemLimit); err != nil || memory != 2560 {
		t.Errorf("MemoryLimitMiB = %d, %v; want 2560", memory, err)
	}
	if _, err := driver.MemoryLimitMiB("2gb"); err == nil {
		t.Error("invalid memory unit should fail")
	}
}

func TestFactory(t *testing.T) {
	if _, err := driver.New("docker", "muad-net", "/skills", driver.K8sOptions{}); err != nil {
		t.Errorf("docker factory: %v", err)
	}
	if _, err := driver.New("swarm", "", "", driver.K8sOptions{}); err == nil {
		t.Error("expected error for unknown kind")
	}
	// k8s factory needs a real cluster (in-cluster/kubeconfig); its CRUD logic
	// is covered by the white-box fake-client test in internal/driver.
}

func TestDockerUpdateSpecNoop(t *testing.T) {
	drv := driver.NewDockerDriver("muad-net", "/skills")
	err := drv.UpdateSpec(context.Background(), "alice", driver.PodSpec{PodID: "alice"})
	if err != nil {
		t.Fatalf("UpdateSpec should not shell out or recreate for docker: %v", err)
	}
}
