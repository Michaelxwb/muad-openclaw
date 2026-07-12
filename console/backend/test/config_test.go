package test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
)

// envOnly points CONSOLE_CONFIG at a non-existent file so any real config.yaml
// in the working directory doesn't leak into these tests.
func envOnly(t *testing.T) {
	t.Helper()
	t.Setenv("CONSOLE_CONFIG", filepath.Join(t.TempDir(), "no-such.yaml"))
}

func TestLoad_MissingMasterKey(t *testing.T) {
	envOnly(t)
	t.Setenv("CONSOLE_MASTER_KEY", "")
	if _, err := config.Load(); err == nil {
		t.Fatal("expected error when CONSOLE_MASTER_KEY is unset")
	}
}

func TestLoad_InvalidDriver(t *testing.T) {
	envOnly(t)
	t.Setenv("CONSOLE_MASTER_KEY", "secret")
	t.Setenv("RUNTIME_DRIVER", "swarm")
	if _, err := config.Load(); err == nil {
		t.Fatal("expected error for invalid RUNTIME_DRIVER")
	}
}

func TestLoad_DefaultsAndValid(t *testing.T) {
	envOnly(t)
	t.Setenv("CONSOLE_MASTER_KEY", "secret")
	t.Setenv("RUNTIME_DRIVER", "")
	t.Setenv("MUAD_NET", "")
	t.Setenv("CONSOLE_JWT_SECRET", "")

	c, err := config.Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.RuntimeDriver != "docker" {
		t.Errorf("default RuntimeDriver = %q, want docker", c.RuntimeDriver)
	}
	if c.MuadNet != "muad-net" {
		t.Errorf("default MuadNet = %q, want muad-net", c.MuadNet)
	}
	if c.JWTSecret != "secret" {
		t.Errorf("JWTSecret should fall back to MasterKey, got %q", c.JWTSecret)
	}
	if c.ConsoleInternalURL != "http://muad-console:8080" {
		t.Errorf("ConsoleInternalURL = %q, want internal service default", c.ConsoleInternalURL)
	}
	if c.LogDir != "" {
		t.Errorf("LogDir = %q, want disabled by default", c.LogDir)
	}
	if c.RuntimeDefaults.MaxSkillConcurrency != 2 {
		t.Errorf("MaxSkillConcurrency = %d, want 2", c.RuntimeDefaults.MaxSkillConcurrency)
	}
	if c.RuntimeDefaults.MaxBrowserConcurrency != 2 {
		t.Errorf("MaxBrowserConcurrency = %d, want 2", c.RuntimeDefaults.MaxBrowserConcurrency)
	}
	if c.RuntimeDefaults.BrowserCDPPortStart != 18802 || c.RuntimeDefaults.BrowserCDPPortEnd != 65535 {
		t.Errorf("Browser CDP range = %d-%d, want 18802-65535", c.RuntimeDefaults.BrowserCDPPortStart, c.RuntimeDefaults.BrowserCDPPortEnd)
	}
}

func TestLoad_YAMLPicksUpDefaults(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONSOLE_MASTER_KEY", "master-from-env")
	t.Setenv("CONSOLE_CONFIG", filepath.Join(dir, "config.yaml"))

	os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`
runtimeDriver: k8s
listenAddr: ":9090"
consoleInternalURL: "http://console.test:8080"
logDir: "/tmp/muad-console-logs"
collectIntervalSec: 60
runtimeDefaults:
  maxSkillConcurrency: 2
  maxBrowserConcurrency: 3
  browserCDPPortStart: 19000
  browserCDPPortEnd: 19100
`), 0o644)

	c, err := config.Load()
	if err != nil {
		t.Fatalf("Load with yaml: %v", err)
	}
	if c.RuntimeDriver != "k8s" {
		t.Errorf("RuntimeDriver = %q, want k8s from yaml", c.RuntimeDriver)
	}
	if c.ListenAddr != ":9090" {
		t.Errorf("ListenAddr = %q, want :9090 from yaml", c.ListenAddr)
	}
	if c.ConsoleInternalURL != "http://console.test:8080" {
		t.Errorf("ConsoleInternalURL = %q, want YAML value", c.ConsoleInternalURL)
	}
	if c.LogDir != "/tmp/muad-console-logs" {
		t.Errorf("LogDir = %q, want YAML value", c.LogDir)
	}
	if c.CollectIntervalSec != 60 {
		t.Errorf("CollectIntervalSec = %d, want 60 from yaml", c.CollectIntervalSec)
	}
	if c.RuntimeDefaults.MaxSkillConcurrency != 2 || c.RuntimeDefaults.MaxBrowserConcurrency != 3 {
		t.Errorf("runtime concurrency = %d/%d, want 2/3", c.RuntimeDefaults.MaxSkillConcurrency, c.RuntimeDefaults.MaxBrowserConcurrency)
	}
	if c.RuntimeDefaults.BrowserCDPPortStart != 19000 || c.RuntimeDefaults.BrowserCDPPortEnd != 19100 {
		t.Errorf("Browser CDP range = %d-%d, want 19000-19100", c.RuntimeDefaults.BrowserCDPPortStart, c.RuntimeDefaults.BrowserCDPPortEnd)
	}
	// defaults still apply for fields not in yaml
	if c.DefaultImage != "ghcr.io/michaelxwb/muad-openclaw:latest" {
		t.Errorf("DefaultImage = %q, want default", c.DefaultImage)
	}
	// MasterKey from env (not in yaml)
	if c.MasterKey != "master-from-env" {
		t.Errorf("MasterKey = %q, want env value", c.MasterKey)
	}
}

func TestLoad_YAMLMasterKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONSOLE_MASTER_KEY", "") // no env, rely on yaml
	t.Setenv("CONSOLE_CONFIG", filepath.Join(dir, "config.yaml"))

	os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`masterKey: "from-yaml"`), 0o644)

	c, err := config.Load()
	if err != nil {
		t.Fatalf("Load with yaml masterKey: %v", err)
	}
	if c.MasterKey != "from-yaml" {
		t.Errorf("MasterKey = %q, want from-yaml", c.MasterKey)
	}
}

func TestLoad_EnvOverridesYAMLMasterKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONSOLE_MASTER_KEY", "from-env")
	t.Setenv("CONSOLE_CONFIG", filepath.Join(dir, "config.yaml"))

	os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`masterKey: "from-yaml"`), 0o644)

	c, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.MasterKey != "from-env" {
		t.Errorf("MasterKey = %q, want from-env (env > yaml)", c.MasterKey)
	}
}

func TestLoad_EnvOverridesYAML(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONSOLE_MASTER_KEY", "mk")
	t.Setenv("CONSOLE_CONFIG", filepath.Join(dir, "config.yaml"))

	os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`
runtimeDriver: docker
listenAddr: ":9090"
`), 0o644)

	// env should win over yaml
	t.Setenv("RUNTIME_DRIVER", "k8s") // env trumps yaml
	t.Setenv("CONSOLE_LOG_DIR", "/tmp/env-console-logs")
	c, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.RuntimeDriver != "k8s" {
		t.Errorf("RuntimeDriver = %q, want k8s (env > yaml docker)", c.RuntimeDriver)
	}
	if c.ListenAddr != ":9090" {
		t.Errorf("ListenAddr = %q, want yaml :9090 (no env override)", c.ListenAddr)
	}
	if c.LogDir != "/tmp/env-console-logs" {
		t.Errorf("LogDir = %q, want env override", c.LogDir)
	}
}

func TestLoad_MissingFileIsOK(t *testing.T) {
	t.Setenv("CONSOLE_MASTER_KEY", "mk")
	t.Setenv("CONSOLE_CONFIG", "/tmp/no-such-config-xyz.yaml")

	c, err := config.Load()
	if err != nil {
		t.Fatalf("missing yaml should be OK: %v", err)
	}
	if c.RuntimeDriver != "docker" {
		t.Errorf("expected default runtimeDriver, got %q", c.RuntimeDriver)
	}
}

func TestLoad_RuntimeDefaultsEnvOverridesYAML(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONSOLE_MASTER_KEY", "mk")
	t.Setenv("CONSOLE_CONFIG", filepath.Join(dir, "config.yaml"))
	t.Setenv("CONSOLE_RUNTIME_MAX_SKILL_CONCURRENCY", "4")
	t.Setenv("CONSOLE_RUNTIME_MAX_BROWSER_CONCURRENCY", "5")
	t.Setenv("CONSOLE_RUNTIME_BROWSER_CDP_PORT_START", "20000")
	t.Setenv("CONSOLE_RUNTIME_BROWSER_CDP_PORT_END", "20100")

	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`
runtimeDefaults:
  maxSkillConcurrency: 2
  maxBrowserConcurrency: 3
  browserCDPPortStart: 19000
  browserCDPPortEnd: 19100
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	c, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.RuntimeDefaults.MaxSkillConcurrency != 4 || c.RuntimeDefaults.MaxBrowserConcurrency != 5 {
		t.Errorf("runtime concurrency = %d/%d, want 4/5", c.RuntimeDefaults.MaxSkillConcurrency, c.RuntimeDefaults.MaxBrowserConcurrency)
	}
	if c.RuntimeDefaults.BrowserCDPPortStart != 20000 || c.RuntimeDefaults.BrowserCDPPortEnd != 20100 {
		t.Errorf("Browser CDP range = %d-%d, want 20000-20100", c.RuntimeDefaults.BrowserCDPPortStart, c.RuntimeDefaults.BrowserCDPPortEnd)
	}
}

func TestLoad_RejectsInvalidRuntimeDefaults(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "non integer", key: "CONSOLE_RUNTIME_MAX_SKILL_CONCURRENCY", value: "many"},
		{name: "zero skill concurrency", key: "CONSOLE_RUNTIME_MAX_SKILL_CONCURRENCY", value: "0"},
		{name: "negative browser concurrency", key: "CONSOLE_RUNTIME_MAX_BROWSER_CONCURRENCY", value: "-1"},
		{name: "port below minimum", key: "CONSOLE_RUNTIME_BROWSER_CDP_PORT_START", value: "1000"},
		{name: "port above maximum", key: "CONSOLE_RUNTIME_BROWSER_CDP_PORT_END", value: "65536"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			envOnly(t)
			t.Setenv("CONSOLE_MASTER_KEY", "mk")
			t.Setenv(tt.key, tt.value)
			if _, err := config.Load(); err == nil {
				t.Fatalf("expected error for %s=%q", tt.key, tt.value)
			}
		})
	}
}

func TestLoad_RejectsReversedBrowserPortRange(t *testing.T) {
	envOnly(t)
	t.Setenv("CONSOLE_MASTER_KEY", "mk")
	t.Setenv("CONSOLE_RUNTIME_BROWSER_CDP_PORT_START", "20000")
	t.Setenv("CONSOLE_RUNTIME_BROWSER_CDP_PORT_END", "19999")
	if _, err := config.Load(); err == nil {
		t.Fatal("expected error for reversed browser CDP port range")
	}
}

func TestLoad_ConsoleInternalURLEnvOverrideAndValidation(t *testing.T) {
	envOnly(t)
	t.Setenv("CONSOLE_MASTER_KEY", "mk")
	t.Setenv("CONSOLE_INTERNAL_URL", "https://console.internal")
	loaded, err := config.Load()
	if err != nil || loaded.ConsoleInternalURL != "https://console.internal" {
		t.Fatalf("internal URL override = %q, %v", loaded.ConsoleInternalURL, err)
	}
	t.Setenv("CONSOLE_INTERNAL_URL", "console.internal")
	if _, err := config.Load(); err == nil {
		t.Fatal("internal URL without http scheme should fail")
	}
}
