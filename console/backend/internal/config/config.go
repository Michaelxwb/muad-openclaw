// Package config loads the console's runtime configuration from (in priority
// order) environment variables, config.yaml, and built-in defaults.  env >
// yaml > default.  The config file path is `config.yaml` in the working
// directory by default and can be overridden with CONSOLE_CONFIG.
//
// config.yaml is the single source of truth, secrets included (masterKey,
// adminPassword); it stays gitignored and is mounted at runtime, so it never
// enters the image (NFR-SEC-02).  Env vars remain available as an optional
// highest-priority override.
package config

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// yamlFile mirrors the shape of config.yaml.  All fields are optional so a
// minimal file (just listenAddr / dbPath) is valid.
type yamlFile struct {
	RuntimeDriver      *string              `yaml:"runtimeDriver"`
	DefaultImage       *string              `yaml:"defaultImage"`
	MuadNet            *string              `yaml:"muadNet"`
	SkillsDir          *string              `yaml:"skillsDir"`
	ListenAddr         *string              `yaml:"listenAddr"`
	LogDir             *string              `yaml:"logDir"`
	DBPath             *string              `yaml:"dbPath"`
	JWTSecret          *string              `yaml:"jwtSecret"`
	AdminUser          *string              `yaml:"adminUser"`
	AdminPassword      *string              `yaml:"adminPassword"`
	MasterKey          *string              `yaml:"masterKey"`
	CollectIntervalSec *int                 `yaml:"collectIntervalSec"`
	ConsoleInternalURL *string              `yaml:"consoleInternalURL"`
	RuntimeDefaults    *runtimeDefaultsYAML `yaml:"runtimeDefaults"`
	// k8s driver (used when runtimeDriver=k8s)
	K8sNamespace          *string               `yaml:"k8sNamespace"`
	K8sSkillsPVC          *string               `yaml:"k8sSkillsPVC"`
	K8sSkillsStorageClass *string               `yaml:"k8sSkillsStorageClass"`
	K8sSkillsSize         *string               `yaml:"k8sSkillsSize"`
	K8sStorageClass       *string               `yaml:"k8sStorageClass"`
	K8sStateSize          *string               `yaml:"k8sStateSize"`
	Security              *securityYAML         `yaml:"security"`
	Admin                 *adminYAML            `yaml:"admin"`
	Server                *serverYAML           `yaml:"server"`
	Runtime               *runtimeYAML          `yaml:"runtime"`
	Docker                *dockerYAML           `yaml:"docker"`
	K8s                   *k8sYAML              `yaml:"k8s"`
	Resources             *resourceDefaultsYAML `yaml:"resources"`
	Browser               *browserYAML          `yaml:"browser"`
}

type runtimeDefaultsYAML struct {
	MemLimit              *string `yaml:"memLimit"`
	CPULimit              *string `yaml:"cpuLimit"`
	RestartPolicy         *string `yaml:"restartPolicy"`
	MaxSkillConcurrency   *int    `yaml:"maxSkillConcurrency"`
	MaxBrowserConcurrency *int    `yaml:"maxBrowserConcurrency"`
	BrowserCDPPortStart   *int    `yaml:"browserCDPPortStart"`
	BrowserCDPPortEnd     *int    `yaml:"browserCDPPortEnd"`
}

type securityYAML struct {
	MasterKey *string `yaml:"masterKey"`
	JWTSecret *string `yaml:"jwtSecret"`
}

type adminYAML struct {
	User     *string `yaml:"user"`
	Password *string `yaml:"password"`
}

type serverYAML struct {
	ListenAddr         *string `yaml:"listenAddr"`
	LogDir             *string `yaml:"logDir"`
	DBPath             *string `yaml:"dbPath"`
	CollectIntervalSec *int    `yaml:"collectIntervalSec"`
	ConsoleInternalURL *string `yaml:"consoleInternalURL"`
}

type runtimeYAML struct {
	Driver          *string `yaml:"driver"`
	DefaultImage    *string `yaml:"defaultImage"`
	SkillsDir       *string `yaml:"skillsDir"`
	Timezone        *string `yaml:"timezone"`
	StateDir        *string `yaml:"stateDir"`
	PublicSkillsDir *string `yaml:"publicSkillsDir"`
}

type dockerYAML struct {
	Network *string `yaml:"network"`
}

type k8sYAML struct {
	Namespace          *string `yaml:"namespace"`
	SkillsPVC          *string `yaml:"skillsPVC"`
	SkillsStorageClass *string `yaml:"skillsStorageClass"`
	SkillsSize         *string `yaml:"skillsSize"`
	StorageClass       *string `yaml:"storageClass"`
	StateSize          *string `yaml:"stateSize"`
}

type resourceDefaultsYAML struct {
	MemLimit              *string `yaml:"memLimit"`
	CPULimit              *string `yaml:"cpuLimit"`
	RestartPolicy         *string `yaml:"restartPolicy"`
	MaxSkillConcurrency   *int    `yaml:"maxSkillConcurrency"`
	MaxBrowserConcurrency *int    `yaml:"maxBrowserConcurrency"`
}

type browserYAML struct {
	CDPPortStart *int `yaml:"cdpPortStart"`
	CDPPortEnd   *int `yaml:"cdpPortEnd"`
}

// RuntimeDefaults contains non-secret limits inherited by Pods that do not
// define an explicit override.
type RuntimeDefaults struct {
	MemLimit              string
	CPULimit              string
	RestartPolicy         string
	MaxSkillConcurrency   int
	MaxBrowserConcurrency int
	BrowserCDPPortStart   int
	BrowserCDPPortEnd     int
}

// Config holds the validated console configuration.
type Config struct {
	MasterKey              string
	RuntimeDriver          string
	DefaultImage           string
	MuadNet                string
	SkillsDir              string
	ListenAddr             string
	LogDir                 string
	DBPath                 string
	JWTSecret              string
	AdminUser              string
	AdminPassword          string
	CollectIntervalSec     int
	ConsoleInternalURL     string
	RuntimeDefaults        RuntimeDefaults
	RuntimeTimezone        string
	RuntimeStateDir        string
	RuntimePublicSkillsDir string
	K8sNamespace           string
	K8sSkillsPVC           string
	K8sSkillsStorageClass  string
	K8sSkillsSize          string
	K8sStorageClass        string
	K8sStateSize           string
}

var validDrivers = map[string]bool{"docker": true, "k8s": true}
var validRestartPolicies = map[string]bool{
	"no": true, "on-failure": true, "always": true, "unless-stopped": true,
}
var (
	memLimitPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?[bkmgBKMG]$`)
	cpuLimitPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
)

// --- defaults (lowest priority) ---

func defaults() *Config {
	return &Config{
		RuntimeDriver:      "docker",
		DefaultImage:       "ghcr.io/michaelxwb/muad-openclaw:latest",
		MuadNet:            "muad-net",
		SkillsDir:          "/var/lib/muad-console/skills",
		ListenAddr:         ":8080",
		DBPath:             "/var/lib/muad-console/console.db",
		ConsoleInternalURL: "http://muad-console:8080",
		// 默认管理员名；只需在 config.yaml 配 adminPassword 即可引导管理员
		// （或 env CONSOLE_ADMIN_PASSWORD）。BootstrapAdmin 要求 user+password 均非空。
		AdminUser:          "admin",
		CollectIntervalSec: 30,
		RuntimeDefaults: RuntimeDefaults{
			MemLimit:              "3g",
			CPULimit:              "2",
			RestartPolicy:         "unless-stopped",
			MaxSkillConcurrency:   2,
			MaxBrowserConcurrency: 2,
			BrowserCDPPortStart:   18802,
			BrowserCDPPortEnd:     65535,
		},
		RuntimeTimezone:        "Asia/Shanghai",
		RuntimeStateDir:        "/home/node/.openclaw",
		RuntimePublicSkillsDir: "/opt/openclaw-skills",
		K8sNamespace:           "muad",
		K8sSkillsSize:          "5Gi",
		K8sStateSize:           "5Gi",
	}
}

// Load reads config.yaml (if present), overlays env, and validates.
func Load() (*Config, error) {
	c := defaults()

	// 1. Lowest priority: config.yaml.
	path := envOr("CONSOLE_CONFIG", "config.yaml")
	if data, err := os.ReadFile(path); err == nil {
		if err := applyYAML(c, data); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	// If the file doesn't exist: silently use defaults (friendly for containers
	// that only inject env vars).

	// 2. Highest priority: environment overrides everything (including secrets).
	if err := c.overrideFromEnv(); err != nil {
		return nil, err
	}

	// 3. Post-merge fixups.
	if c.JWTSecret == "" {
		c.JWTSecret = c.MasterKey
	}

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

// --- yaml ---

func applyYAML(c *Config, raw []byte) error {
	var f yamlFile
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("invalid yaml: %w", err)
	}
	applyLegacyYAML(c, &f)
	applyGroupedYAML(c, &f)
	return nil
}

func applyLegacyYAML(c *Config, f *yamlFile) {
	applyString(&c.RuntimeDriver, f.RuntimeDriver)
	applyString(&c.DefaultImage, f.DefaultImage)
	applyString(&c.MuadNet, f.MuadNet)
	applyString(&c.SkillsDir, f.SkillsDir)
	applyString(&c.MasterKey, f.MasterKey)
	applyString(&c.ListenAddr, f.ListenAddr)
	applyString(&c.LogDir, f.LogDir)
	applyString(&c.DBPath, f.DBPath)
	applyString(&c.JWTSecret, f.JWTSecret)
	applyString(&c.AdminUser, f.AdminUser)
	applyString(&c.AdminPassword, f.AdminPassword)
	applyString(&c.ConsoleInternalURL, f.ConsoleInternalURL)
	applyString(&c.K8sNamespace, f.K8sNamespace)
	applyString(&c.K8sSkillsPVC, f.K8sSkillsPVC)
	applyString(&c.K8sSkillsStorageClass, f.K8sSkillsStorageClass)
	applyString(&c.K8sSkillsSize, f.K8sSkillsSize)
	applyString(&c.K8sStorageClass, f.K8sStorageClass)
	applyString(&c.K8sStateSize, f.K8sStateSize)
	if f.CollectIntervalSec != nil && *f.CollectIntervalSec > 0 {
		c.CollectIntervalSec = *f.CollectIntervalSec
	}
	applyRuntimeDefaultsYAML(&c.RuntimeDefaults, f.RuntimeDefaults)
}

func applyGroupedYAML(c *Config, f *yamlFile) {
	if f.Security != nil {
		applyString(&c.MasterKey, f.Security.MasterKey)
		applyString(&c.JWTSecret, f.Security.JWTSecret)
	}
	if f.Admin != nil {
		applyString(&c.AdminUser, f.Admin.User)
		applyString(&c.AdminPassword, f.Admin.Password)
	}
	if f.Server != nil {
		applyServerYAML(c, f.Server)
	}
	if f.Runtime != nil {
		applyRuntimeYAML(c, f.Runtime)
	}
	if f.Docker != nil {
		applyString(&c.MuadNet, f.Docker.Network)
	}
	if f.K8s != nil {
		applyK8sYAML(c, f.K8s)
	}
	applyResourceDefaultsYAML(&c.RuntimeDefaults, f.Resources)
	applyBrowserYAML(&c.RuntimeDefaults, f.Browser)
}

func applyServerYAML(c *Config, src *serverYAML) {
	applyString(&c.ListenAddr, src.ListenAddr)
	applyString(&c.LogDir, src.LogDir)
	applyString(&c.DBPath, src.DBPath)
	applyString(&c.ConsoleInternalURL, src.ConsoleInternalURL)
	if src.CollectIntervalSec != nil && *src.CollectIntervalSec > 0 {
		c.CollectIntervalSec = *src.CollectIntervalSec
	}
}

func applyRuntimeYAML(c *Config, src *runtimeYAML) {
	applyString(&c.RuntimeDriver, src.Driver)
	applyString(&c.DefaultImage, src.DefaultImage)
	applyString(&c.SkillsDir, src.SkillsDir)
	applyString(&c.RuntimeTimezone, src.Timezone)
	applyString(&c.RuntimeStateDir, src.StateDir)
	applyString(&c.RuntimePublicSkillsDir, src.PublicSkillsDir)
}

func applyK8sYAML(c *Config, src *k8sYAML) {
	applyString(&c.K8sNamespace, src.Namespace)
	applyString(&c.K8sSkillsPVC, src.SkillsPVC)
	applyString(&c.K8sSkillsStorageClass, src.SkillsStorageClass)
	applyString(&c.K8sSkillsSize, src.SkillsSize)
	applyString(&c.K8sStorageClass, src.StorageClass)
	applyString(&c.K8sStateSize, src.StateSize)
}

func applyRuntimeDefaultsYAML(dst *RuntimeDefaults, src *runtimeDefaultsYAML) {
	if src == nil {
		return
	}
	applyString(&dst.MemLimit, src.MemLimit)
	applyString(&dst.CPULimit, src.CPULimit)
	applyString(&dst.RestartPolicy, src.RestartPolicy)
	applyInt(&dst.MaxSkillConcurrency, src.MaxSkillConcurrency)
	applyInt(&dst.MaxBrowserConcurrency, src.MaxBrowserConcurrency)
	applyInt(&dst.BrowserCDPPortStart, src.BrowserCDPPortStart)
	applyInt(&dst.BrowserCDPPortEnd, src.BrowserCDPPortEnd)
}

func applyResourceDefaultsYAML(dst *RuntimeDefaults, src *resourceDefaultsYAML) {
	if src == nil {
		return
	}
	applyString(&dst.MemLimit, src.MemLimit)
	applyString(&dst.CPULimit, src.CPULimit)
	applyString(&dst.RestartPolicy, src.RestartPolicy)
	applyInt(&dst.MaxSkillConcurrency, src.MaxSkillConcurrency)
	applyInt(&dst.MaxBrowserConcurrency, src.MaxBrowserConcurrency)
}

func applyBrowserYAML(dst *RuntimeDefaults, src *browserYAML) {
	if src == nil {
		return
	}
	applyInt(&dst.BrowserCDPPortStart, src.CDPPortStart)
	applyInt(&dst.BrowserCDPPortEnd, src.CDPPortEnd)
}

func applyInt(dst *int, src *int) {
	if src != nil {
		*dst = *src
	}
}

func applyString(dst *string, src *string) {
	if src != nil && strings.TrimSpace(*src) != "" {
		*dst = strings.TrimSpace(*src)
	}
}

// --- env ---

func (c *Config) overrideFromEnv() error {
	if v := os.Getenv("CONSOLE_MASTER_KEY"); strings.TrimSpace(v) != "" {
		c.MasterKey = strings.TrimSpace(v)
	}
	envOverride(&c.RuntimeDriver, "RUNTIME_DRIVER")
	envOverride(&c.DefaultImage, "DEFAULT_IMAGE")
	envOverride(&c.MuadNet, "MUAD_NET")
	envOverride(&c.SkillsDir, "CONSOLE_SKILLS_DIR")
	envOverride(&c.ListenAddr, "CONSOLE_LISTEN")
	envOverride(&c.LogDir, "CONSOLE_LOG_DIR")
	envOverride(&c.DBPath, "CONSOLE_DB")
	envOverride(&c.ConsoleInternalURL, "CONSOLE_INTERNAL_URL")
	envOverride(&c.JWTSecret, "CONSOLE_JWT_SECRET")
	envOverride(&c.AdminUser, "CONSOLE_ADMIN_USER")
	envOverride(&c.RuntimeTimezone, "CONSOLE_RUNTIME_TIMEZONE")
	envOverride(&c.RuntimeStateDir, "CONSOLE_RUNTIME_STATE_DIR")
	envOverride(&c.RuntimePublicSkillsDir, "CONSOLE_RUNTIME_PUBLIC_SKILLS_DIR")
	if v := os.Getenv("CONSOLE_ADMIN_PASSWORD"); v != "" {
		c.AdminPassword = v
	}
	envOverride(&c.K8sNamespace, "K8S_NAMESPACE")
	envOverride(&c.K8sSkillsPVC, "K8S_SKILLS_PVC")
	envOverride(&c.K8sSkillsStorageClass, "K8S_SKILLS_STORAGE_CLASS")
	envOverride(&c.K8sSkillsSize, "K8S_SKILLS_SIZE")
	envOverride(&c.K8sStorageClass, "K8S_STORAGE_CLASS")
	envOverride(&c.K8sStateSize, "K8S_STATE_SIZE")
	if v := envIntOr("CONSOLE_COLLECT_INTERVAL", 0); v > 0 {
		c.CollectIntervalSec = v
	}
	for _, item := range []struct {
		dst *int
		key string
	}{
		{&c.RuntimeDefaults.MaxSkillConcurrency, "CONSOLE_RUNTIME_MAX_SKILL_CONCURRENCY"},
		{&c.RuntimeDefaults.MaxBrowserConcurrency, "CONSOLE_RUNTIME_MAX_BROWSER_CONCURRENCY"},
		{&c.RuntimeDefaults.BrowserCDPPortStart, "CONSOLE_RUNTIME_BROWSER_CDP_PORT_START"},
		{&c.RuntimeDefaults.BrowserCDPPortEnd, "CONSOLE_RUNTIME_BROWSER_CDP_PORT_END"},
	} {
		if err := envIntOverride(item.dst, item.key); err != nil {
			return err
		}
	}
	envOverride(&c.RuntimeDefaults.MemLimit, "CONSOLE_RESOURCE_MEM_LIMIT")
	envOverride(&c.RuntimeDefaults.CPULimit, "CONSOLE_RESOURCE_CPU_LIMIT")
	envOverride(&c.RuntimeDefaults.RestartPolicy, "CONSOLE_RESOURCE_RESTART_POLICY")
	return nil
}

func envOverride(dst *string, key string) {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		*dst = v
	}
}

func envIntOverride(dst *int, key string) error {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fmt.Errorf("%s must be an integer: %w", key, err)
	}
	*dst = value
	return nil
}

// --- helpers ---

func (c *Config) validate() error {
	if c.MasterKey == "" {
		return fmt.Errorf("CONSOLE_MASTER_KEY is required (or config.yaml masterKey)")
	}
	if !validDrivers[c.RuntimeDriver] {
		return fmt.Errorf("RUNTIME_DRIVER must be docker or k8s, got %q", c.RuntimeDriver)
	}
	if c.ListenAddr == "" {
		return fmt.Errorf("listenAddr must not be empty")
	}
	if !strings.HasPrefix(c.ConsoleInternalURL, "http://") && !strings.HasPrefix(c.ConsoleInternalURL, "https://") {
		return fmt.Errorf("consoleInternalURL must use http or https")
	}
	if err := validateRuntimePath("runtime.stateDir", c.RuntimeStateDir); err != nil {
		return err
	}
	if err := validateRuntimePath("runtime.publicSkillsDir", c.RuntimePublicSkillsDir); err != nil {
		return err
	}
	if strings.TrimSpace(c.RuntimeTimezone) == "" {
		return fmt.Errorf("runtime.timezone must not be empty")
	}
	if err := c.RuntimeDefaults.validate(); err != nil {
		return err
	}
	return nil
}

func (c RuntimeDefaults) validate() error {
	if !memLimitPattern.MatchString(c.MemLimit) {
		return fmt.Errorf("resources.memLimit must look like 512m / 2g / 2.5g")
	}
	if parsed, err := strconv.ParseFloat(c.CPULimit, 64); !cpuLimitPattern.MatchString(c.CPULimit) || err != nil || parsed <= 0 {
		return fmt.Errorf("resources.cpuLimit must be a positive number like 1.5")
	}
	if !validRestartPolicies[c.RestartPolicy] {
		return fmt.Errorf("resources.restartPolicy must be no / on-failure / always / unless-stopped")
	}
	if c.MaxSkillConcurrency <= 0 {
		return fmt.Errorf("resources.maxSkillConcurrency must be greater than zero")
	}
	if c.MaxBrowserConcurrency <= 0 {
		return fmt.Errorf("resources.maxBrowserConcurrency must be greater than zero")
	}
	if c.BrowserCDPPortStart < 1024 || c.BrowserCDPPortStart > 65535 {
		return fmt.Errorf("browser.cdpPortStart must be between 1024 and 65535")
	}
	if c.BrowserCDPPortEnd < c.BrowserCDPPortStart || c.BrowserCDPPortEnd > 65535 {
		return fmt.Errorf("browser.cdpPortEnd must be between cdpPortStart and 65535")
	}
	return nil
}

func validateRuntimePath(name, value string) error {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "/") || strings.ContainsAny(trimmed, "\n\r\x00") {
		return fmt.Errorf("%s must be an absolute runtime path", name)
	}
	return nil
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envIntOr(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
