// Package config loads the console's runtime configuration from (in priority
// order) environment variables, config.yaml, and built-in defaults.  env >
// yaml > default.  The config file path is `config.yaml` in the working
// directory by default and can be overridden with CONSOLE_CONFIG.
//
// AdminPassword ONLY comes from the environment (NFR-SEC-02).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// yamlFile mirrors the shape of config.yaml.  All fields are optional so a
// minimal file (just listenAddr / dbPath) is valid.
type yamlFile struct {
	RuntimeDriver      *string `yaml:"runtimeDriver"`
	DefaultImage       *string `yaml:"defaultImage"`
	MuadNet            *string `yaml:"muadNet"`
	SkillsDir          *string `yaml:"skillsDir"`
	ListenAddr         *string `yaml:"listenAddr"`
	DBPath             *string `yaml:"dbPath"`
	JWTSecret          *string `yaml:"jwtSecret"`
	AdminUser          *string `yaml:"adminUser"`
	MasterKey          *string `yaml:"masterKey"`
	CollectIntervalSec *int    `yaml:"collectIntervalSec"`
}

// Config holds the validated console configuration.
type Config struct {
	MasterKey string
	RuntimeDriver      string
	DefaultImage       string
	MuadNet            string
	SkillsDir          string
	ListenAddr         string
	DBPath             string
	JWTSecret          string
	AdminUser          string
	AdminPassword      string // env only (NFR-SEC-02)
	CollectIntervalSec int
}

var validDrivers = map[string]bool{"docker": true, "k8s": true}

// --- defaults (lowest priority) ---

func defaults() *Config {
	return &Config{
		RuntimeDriver: "docker",
		DefaultImage:  "ghcr.io/michaelxwb/muad-openclaw:latest",
		MuadNet:       "muad-net",
		SkillsDir:     "/opt/muad/skills",
		ListenAddr:    ":8080",
		DBPath:        "/var/lib/muad-console/console.db",
		// 默认管理员名，使容器化（仅 env、无 config.yaml）部署也能引导管理员：
		// 只需提供 CONSOLE_ADMIN_PASSWORD。BootstrapAdmin 要求 user+password 均非空。
		AdminUser:          "admin",
		CollectIntervalSec: 30,
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
	c.overrideFromEnv()

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
	applyString(&c.RuntimeDriver, f.RuntimeDriver)
	applyString(&c.DefaultImage, f.DefaultImage)
	applyString(&c.MuadNet, f.MuadNet)
	applyString(&c.SkillsDir, f.SkillsDir)
	applyString(&c.MasterKey, f.MasterKey)
	applyString(&c.ListenAddr, f.ListenAddr)
	applyString(&c.DBPath, f.DBPath)
	applyString(&c.JWTSecret, f.JWTSecret)
	applyString(&c.AdminUser, f.AdminUser)
	if f.CollectIntervalSec != nil && *f.CollectIntervalSec > 0 {
		c.CollectIntervalSec = *f.CollectIntervalSec
	}
	return nil
}

func applyString(dst *string, src *string) {
	if src != nil && strings.TrimSpace(*src) != "" {
		*dst = strings.TrimSpace(*src)
	}
}

// --- env ---

func (c *Config) overrideFromEnv() {
	if v := os.Getenv("CONSOLE_MASTER_KEY"); strings.TrimSpace(v) != "" {
		c.MasterKey = strings.TrimSpace(v)
	}
	envOverride(&c.RuntimeDriver, "RUNTIME_DRIVER")
	envOverride(&c.DefaultImage, "DEFAULT_IMAGE")
	envOverride(&c.MuadNet, "MUAD_NET")
	envOverride(&c.SkillsDir, "CONSOLE_SKILLS_DIR")
	envOverride(&c.ListenAddr, "CONSOLE_LISTEN")
	envOverride(&c.DBPath, "CONSOLE_DB")
	envOverride(&c.JWTSecret, "CONSOLE_JWT_SECRET")
	envOverride(&c.AdminUser, "CONSOLE_ADMIN_USER")
	if v := os.Getenv("CONSOLE_ADMIN_PASSWORD"); v != "" {
		c.AdminPassword = v
	}
	if v := envIntOr("CONSOLE_COLLECT_INTERVAL", 0); v > 0 {
		c.CollectIntervalSec = v
	}
}

func envOverride(dst *string, key string) {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		*dst = v
	}
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
