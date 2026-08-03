package test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestConsoleManifestAllowsPVCPatchOnly(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "k8s", "console.yaml"))
	if err != nil {
		t.Fatalf("read console manifest: %v", err)
	}
	role := findConsoleRole(t, string(raw))
	hasPVCPatch := false
	for _, rule := range role.Rules {
		if slices.Contains(rule.Resources, "secrets") && slices.Contains(rule.Verbs, "patch") {
			t.Fatal("console Role must not grant patch on secrets")
		}
		if slices.Contains(rule.Resources, "persistentvolumeclaims") && slices.Contains(rule.Verbs, "patch") {
			hasPVCPatch = true
		}
	}
	if !hasPVCPatch {
		t.Fatal("console Role must grant patch on persistentvolumeclaims")
	}
}

func findConsoleRole(t *testing.T, manifest string) consoleRoleManifest {
	t.Helper()
	for _, doc := range strings.Split(manifest, "\n---") {
		var item consoleRoleManifest
		if err := yaml.Unmarshal([]byte(doc), &item); err != nil {
			t.Fatalf("parse console manifest: %v", err)
		}
		if item.Kind == "Role" && item.Metadata.Name == "muad-console" {
			return item
		}
	}
	t.Fatal("muad-console Role not found")
	return consoleRoleManifest{}
}

type consoleRoleManifest struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Rules []struct {
		Resources []string `yaml:"resources"`
		Verbs     []string `yaml:"verbs"`
	} `yaml:"rules"`
}
