package test

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// helmTemplateStrip 剔除 Helm 模板指令 {{...}}，留下可解析的 YAML 骨架。
// 本测试只校验 Role rules 的安全不变量；metadata 的 name/labels 是模板变量，不在校验范围。
var helmTemplateStrip = regexp.MustCompile(`\{\{-?[\s\S]*?-?\}\}`)

func TestConsoleManifestAllowsPVCPatchOnly(t *testing.T) {
	// Role 源已从 k8s/console.yaml 迁到 Helm chart 模板（k8s/ 目录已废弃删除）。
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "build", "helm-build", "muad-console", "templates", "role.yaml"))
	if err != nil {
		t.Fatalf("read console role template: %v", err)
	}
	role := findConsoleRole(t, helmTemplateStrip.ReplaceAllString(string(raw), ""))
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
			t.Fatalf("parse console role template: %v", err)
		}
		if item.Kind == "Role" {
			return item
		}
	}
	t.Fatal("console Role not found")
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
