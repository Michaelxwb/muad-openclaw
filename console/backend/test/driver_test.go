package test

import (
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
)

func TestMergeLLM_OverrideWins(t *testing.T) {
	global := driver.LlmConfig{Provider: "deepseek", BaseURL: "https://api.deepseek.com", APIKey: "g-key", Model: "deepseek-v4"}
	override := driver.LlmConfig{Model: "deepseek-r2", APIKey: "u-key"}

	got := driver.MergeLLM(global, override)
	if got.Model != "deepseek-r2" {
		t.Errorf("Model = %q, want override deepseek-r2", got.Model)
	}
	if got.APIKey != "u-key" {
		t.Errorf("APIKey = %q, want override u-key", got.APIKey)
	}
	if got.Provider != "deepseek" {
		t.Errorf("Provider = %q, want inherited deepseek", got.Provider)
	}
	if got.BaseURL != "https://api.deepseek.com" {
		t.Errorf("BaseURL = %q, want inherited", got.BaseURL)
	}
}

func TestMergeLLM_EmptyOverrideInherits(t *testing.T) {
	global := driver.LlmConfig{Provider: "deepseek", Model: "deepseek-v4"}
	got := driver.MergeLLM(global, driver.LlmConfig{})
	if got != global {
		t.Errorf("empty override should inherit global, got %+v", got)
	}
}

func TestBuildEnv_OmitsEmptyLLM(t *testing.T) {
	spec := driver.UserSpec{UserID: "alice", BotID: "wb-1", Secret: "s"}
	env := driver.BuildEnv(spec, "tok")

	if env["PC_USER"] != "alice" || env["WECOM_BOT_ID"] != "wb-1" || env["WECOM_SECRET"] != "s" {
		t.Fatalf("missing required identity env: %+v", env)
	}
	if env["OPENCLAW_GATEWAY_TOKEN"] != "tok" {
		t.Errorf("gateway token not set")
	}
	if _, ok := env["LLM_MODEL"]; ok {
		t.Errorf("empty LLM_MODEL should be omitted to keep image baseline default")
	}
}

func TestBuildEnv_IncludesLLM(t *testing.T) {
	spec := driver.UserSpec{
		UserID: "bob", BotID: "wb-2", Secret: "s2",
		LLM: driver.LlmConfig{Provider: "deepseek", BaseURL: "https://x", APIKey: "k", Model: "m"},
	}
	env := driver.BuildEnv(spec, "")
	for k, want := range map[string]string{
		"LLM_PROVIDER": "deepseek", "LLM_BASE_URL": "https://x", "LLM_API_KEY": "k", "LLM_MODEL": "m",
	} {
		if env[k] != want {
			t.Errorf("env[%s] = %q, want %q", k, env[k], want)
		}
	}
	if _, ok := env["OPENCLAW_GATEWAY_TOKEN"]; ok {
		t.Errorf("empty gateway token should be omitted")
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
