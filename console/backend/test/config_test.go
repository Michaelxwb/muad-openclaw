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
}

func TestLoad_YAMLPicksUpDefaults(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONSOLE_MASTER_KEY", "master-from-env")
	t.Setenv("CONSOLE_CONFIG", filepath.Join(dir, "config.yaml"))

	os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`
runtimeDriver: k8s
listenAddr: ":9090"
collectIntervalSec: 60
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
	if c.CollectIntervalSec != 60 {
		t.Errorf("CollectIntervalSec = %d, want 60 from yaml", c.CollectIntervalSec)
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
