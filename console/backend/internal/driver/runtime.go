package driver

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
)

const (
	RuntimeConfigVersion     = 1
	PodServiceTokenPath      = "/run/secrets/muad/pod-service-token"
	DefaultQuarantineProfile = "quarantine"
	DefaultQuarantineCDPPort = 18801
	DefaultRuntimeUID        = 1000
	DefaultRuntimeGID        = 1000
)

var (
	ErrInvalidPodSpec       = errors.New("driver: invalid Pod spec")
	ErrInvalidRuntimeConfig = errors.New("driver: invalid runtime config")
	ErrRetainedState        = errors.New("driver: retained state requires explicit adoption")
	podIDPattern            = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
)

// PodSpec is the runtime-agnostic desired state for one multi-user workload.
type PodSpec struct {
	PodID                   string
	Channels                []string
	ChannelConfigs          map[string]json.RawMessage
	ImageTag                string
	GatewayToken            string
	AutomationPlatformURL   string
	AutomationPlatformToken string
	MultiUser               RuntimeConfigV1
	Resource                ResourceSpec
	ServiceToken            SecretFileSpec
	AdoptState              bool
}

// ResourceSpec contains already-resolved Pod resource and concurrency limits.
type ResourceSpec struct {
	MemLimit              string
	CPULimit              string
	RestartPolicy         string
	MaxSkillConcurrency   int
	MaxBrowserConcurrency int
}

// SecretFileSpec describes one runtime secret mount. Value is never serialized.
type SecretFileSpec struct {
	Name          string
	ContainerPath string
	Value         string `json:"-"`
	Mode          uint32
	UID           int64
	GID           int64
}

// RuntimeConfigV1 is the versioned Go/Node configuration contract.
type RuntimeConfigV1 struct {
	Version            int                   `json:"version"`
	PodID              string                `json:"podId"`
	Generation         int64                 `json:"generation"`
	ConsoleInternalURL string                `json:"consoleInternalUrl"`
	ServiceTokenFile   string                `json:"serviceTokenFile"`
	Concurrency        RuntimeConcurrency    `json:"concurrency"`
	Channels           RuntimeChannels       `json:"channels"`
	Agents             []RuntimeAgent        `json:"agents"`
	Routes             []RuntimeRoute        `json:"routes"`
	IdentityLinks      []RuntimeIdentityLink `json:"identityLinks"`
	Browser            RuntimeBrowser        `json:"browser"`
	Providers          []RuntimeProvider     `json:"providers"`
	Platforms          []RuntimePlatform     `json:"platforms"`
	Skills             RuntimeSkills         `json:"skills"`
	SessionManager     RuntimeSessionManager `json:"sessionManager"`
	Guard              RuntimeGuard          `json:"guard"`
}

type RuntimeConcurrency struct {
	MaxSkills  int `json:"maxSkills"`
	MaxBrowser int `json:"maxBrowser"`
}

type RuntimeChannels struct {
	Enabled []string                   `json:"enabled"`
	Configs map[string]json.RawMessage `json:"configs"`
}

type RuntimeAgent struct {
	ID             string            `json:"id"`
	Default        bool              `json:"default"`
	Status         string            `json:"status"`
	Workspace      string            `json:"workspace"`
	AgentDir       string            `json:"agentDir"`
	BrowserProfile string            `json:"browserProfile,omitempty"`
	Model          string            `json:"model,omitempty"`
	Skills         []string          `json:"skills"`
	Tools          RuntimeToolPolicy `json:"tools"`
}

type RuntimeToolPolicy struct {
	Allow         []string `json:"allow,omitempty"`
	Deny          []string `json:"deny,omitempty"`
	WorkspaceOnly bool     `json:"workspaceOnly"`
}

type RuntimeRoute struct {
	AgentID    string `json:"agentId"`
	Channel    string `json:"channel"`
	AccountID  string `json:"accountId"`
	PeerKind   string `json:"peerKind"`
	ExternalID string `json:"externalId"`
}

type RuntimeIdentityLink struct {
	AgentID    string   `json:"agentId"`
	Identities []string `json:"identities"`
}

type RuntimeBrowser struct {
	DefaultProfile string                  `json:"defaultProfile"`
	Profiles       []RuntimeBrowserProfile `json:"profiles"`
}

type RuntimeBrowserProfile struct {
	ID      string `json:"id"`
	Driver  string `json:"driver"`
	CDPPort int    `json:"cdpPort"`
}

type RuntimeProvider struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
}

type RuntimePlatform struct {
	ID          string          `json:"id"`
	DisplayName string          `json:"displayName"`
	Config      json.RawMessage `json:"config"`
}

type RuntimeSkills struct {
	PublicDirectory string               `json:"publicDirectory"`
	PrivateRoot     string               `json:"privateRoot"`
	Agents          []RuntimeAgentSkills `json:"agents"`
}

type RuntimeAgentSkills struct {
	AgentID string              `json:"agentId"`
	Allowed []RuntimeSkillGrant `json:"allowed"`
}

type RuntimeSkillGrant struct {
	Name        string   `json:"name"`
	Source      string   `json:"source"`
	SkillID     string   `json:"skillId"`
	Version     string   `json:"version"`
	EntryType   string   `json:"entryType"`
	RootPath    string   `json:"rootPath"`
	ScriptFiles []string `json:"scriptFiles"`
}

type RuntimeSessionManager struct {
	Agents []RuntimeSessionAgent `json:"agents"`
}

type RuntimeSessionAgent struct {
	AgentID        string `json:"agentId"`
	Workspace      string `json:"workspace"`
	StoreDirectory string `json:"storeDirectory"`
}

type RuntimeGuard struct {
	MainAgentID       string                `json:"mainAgentId"`
	QuarantineProfile string                `json:"quarantineProfile"`
	AgentProfiles     []RuntimeAgentProfile `json:"agentProfiles"`
}

type RuntimeAgentProfile struct {
	AgentID string `json:"agentId"`
	Profile string `json:"profile"`
}

// Validate checks the cross-runtime invariants required before rendering.
func (config RuntimeConfigV1) Validate() error {
	if config.Version != RuntimeConfigVersion || !podIDPattern.MatchString(config.PodID) || config.Generation <= 0 {
		return ErrInvalidRuntimeConfig
	}
	if strings.TrimSpace(config.ConsoleInternalURL) == "" || config.ServiceTokenFile != PodServiceTokenPath {
		return ErrInvalidRuntimeConfig
	}
	if config.Concurrency.MaxSkills <= 0 || config.Concurrency.MaxBrowser <= 0 {
		return ErrInvalidRuntimeConfig
	}
	if err := validateRuntimeChannels(config.Channels); err != nil {
		return err
	}
	if err := validateRuntimeAgents(config.Agents); err != nil {
		return err
	}
	if err := validateRuntimeBrowser(config.Browser, config.Agents); err != nil {
		return err
	}
	return validateRuntimeReferences(config)
}

func validateRuntimeChannels(channels RuntimeChannels) error {
	if len(channels.Enabled) == 0 || channels.Configs == nil {
		return ErrInvalidRuntimeConfig
	}
	seen := make(map[string]struct{}, len(channels.Enabled))
	for _, channel := range channels.Enabled {
		if !podIDPattern.MatchString(channel) {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := seen[channel]; exists {
			return ErrInvalidRuntimeConfig
		}
		seen[channel] = struct{}{}
	}
	for channel, raw := range channels.Configs {
		if _, exists := seen[channel]; !exists || !json.Valid(raw) || len(raw) == 0 {
			return ErrInvalidRuntimeConfig
		}
		var value map[string]string
		if err := json.Unmarshal(raw, &value); err != nil || value == nil {
			return ErrInvalidRuntimeConfig
		}
	}
	return nil
}

// Validate checks Pod deployment fields and its embedded Runtime DTO.
func (spec PodSpec) Validate() error {
	if !podIDPattern.MatchString(spec.PodID) || strings.TrimSpace(spec.ImageTag) == "" {
		return ErrInvalidPodSpec
	}
	if spec.MultiUser.PodID != spec.PodID || spec.ServiceToken.ContainerPath != PodServiceTokenPath ||
		strings.TrimSpace(spec.ServiceToken.Value) == "" {
		return ErrInvalidPodSpec
	}
	if spec.Resource.MaxSkillConcurrency <= 0 || spec.Resource.MaxBrowserConcurrency <= 0 ||
		!IsValidRestartPolicy(spec.Resource.RestartPolicy) {
		return ErrInvalidPodSpec
	}
	if err := spec.MultiUser.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidPodSpec, err)
	}
	return nil
}

// DecodeRuntimeConfig rejects unknown fields and trailing JSON values.
func DecodeRuntimeConfig(reader io.Reader) (RuntimeConfigV1, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var config RuntimeConfigV1
	if err := decoder.Decode(&config); err != nil {
		return RuntimeConfigV1{}, fmt.Errorf("decode runtime config: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return RuntimeConfigV1{}, errors.New("decode runtime config: trailing JSON value")
	}
	if err := config.Validate(); err != nil {
		return RuntimeConfigV1{}, err
	}
	return config, nil
}

func validateRuntimeAgents(agents []RuntimeAgent) error {
	if len(agents) == 0 || agents[0].ID != "main" || !agents[0].Default {
		return ErrInvalidRuntimeConfig
	}
	ids := make(map[string]struct{}, len(agents))
	defaultCount := 0
	for _, agent := range agents {
		if !podIDPattern.MatchString(agent.ID) || agent.Workspace == "" || agent.AgentDir == "" ||
			agent.Skills == nil || hasInvalidOrDuplicateSkills(agent.Skills) {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := ids[agent.ID]; exists {
			return ErrInvalidRuntimeConfig
		}
		ids[agent.ID] = struct{}{}
		if agent.Default {
			defaultCount++
		}
	}
	if defaultCount != 1 {
		return ErrInvalidRuntimeConfig
	}
	return nil
}

func hasInvalidOrDuplicateSkills(skills []string) bool {
	seen := make(map[string]struct{}, len(skills))
	for _, skill := range skills {
		if !podIDPattern.MatchString(skill) {
			return true
		}
		if _, duplicate := seen[skill]; duplicate {
			return true
		}
		seen[skill] = struct{}{}
	}
	return false
}

func validateRuntimeBrowser(browser RuntimeBrowser, agents []RuntimeAgent) error {
	if browser.DefaultProfile != DefaultQuarantineProfile || len(browser.Profiles) == 0 {
		return ErrInvalidRuntimeConfig
	}
	profiles := make(map[string]struct{}, len(browser.Profiles))
	ports := make(map[int]struct{}, len(browser.Profiles))
	for _, profile := range browser.Profiles {
		if !podIDPattern.MatchString(profile.ID) || profile.CDPPort < 1024 || profile.CDPPort > 65535 {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := profiles[profile.ID]; exists {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := ports[profile.CDPPort]; exists {
			return ErrInvalidRuntimeConfig
		}
		profiles[profile.ID] = struct{}{}
		ports[profile.CDPPort] = struct{}{}
	}
	if _, exists := profiles[browser.DefaultProfile]; !exists {
		return ErrInvalidRuntimeConfig
	}
	return validateAgentProfiles(agents, profiles)
}

func validateAgentProfiles(agents []RuntimeAgent, profiles map[string]struct{}) error {
	for _, agent := range agents {
		if agent.ID == "main" && agent.BrowserProfile != "" {
			return ErrInvalidRuntimeConfig
		}
		if agent.BrowserProfile != "" {
			if _, exists := profiles[agent.BrowserProfile]; !exists {
				return ErrInvalidRuntimeConfig
			}
		}
	}
	return nil
}

func validateRuntimeReferences(config RuntimeConfigV1) error {
	agents := make(map[string]RuntimeAgent, len(config.Agents))
	for _, agent := range config.Agents {
		agents[agent.ID] = agent
	}
	for _, route := range config.Routes {
		if _, exists := agents[route.AgentID]; !exists || route.Channel == "" ||
			route.AccountID == "" || route.PeerKind == "" || route.ExternalID == "" {
			return ErrInvalidRuntimeConfig
		}
	}
	providers := make(map[string]struct{}, len(config.Providers))
	for _, provider := range config.Providers {
		if provider.ID == "" || provider.Provider == "" || provider.Model == "" {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := providers[provider.ID]; exists {
			return ErrInvalidRuntimeConfig
		}
		providers[provider.ID] = struct{}{}
	}
	if err := validateAgentModels(config.Agents, providers); err != nil {
		return err
	}
	if err := validateIdentityLinks(config.IdentityLinks, agents); err != nil {
		return err
	}
	if err := validatePlatforms(config.Platforms); err != nil {
		return err
	}
	if err := validateRuntimeSkills(config.Skills, agents); err != nil {
		return err
	}
	return validateRuntimeMappings(config, agents)
}

func validateAgentModels(agents []RuntimeAgent, providers map[string]struct{}) error {
	for _, agent := range agents {
		if agent.Model == "" {
			continue
		}
		parts := strings.SplitN(agent.Model, "/", 2)
		if len(parts) != 2 || parts[1] == "" {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := providers[parts[0]]; !exists {
			return ErrInvalidRuntimeConfig
		}
	}
	return nil
}

func validateIdentityLinks(links []RuntimeIdentityLink, agents map[string]RuntimeAgent) error {
	seen := make(map[string]struct{}, len(links))
	for _, link := range links {
		if len(link.Identities) == 0 {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := agents[link.AgentID]; !exists || link.AgentID == "main" {
			return ErrInvalidRuntimeConfig
		}
		if _, duplicate := seen[link.AgentID]; duplicate {
			return ErrInvalidRuntimeConfig
		}
		seen[link.AgentID] = struct{}{}
		for _, identity := range link.Identities {
			if !strings.Contains(identity, ":") {
				return ErrInvalidRuntimeConfig
			}
		}
	}
	return nil
}

func validatePlatforms(platforms []RuntimePlatform) error {
	seen := make(map[string]struct{}, len(platforms))
	for _, platform := range platforms {
		if platform.ID == "" || platform.DisplayName == "" || !json.Valid(platform.Config) {
			return ErrInvalidRuntimeConfig
		}
		if _, duplicate := seen[platform.ID]; duplicate {
			return ErrInvalidRuntimeConfig
		}
		seen[platform.ID] = struct{}{}
	}
	return nil
}

func validateRuntimeSkills(skills RuntimeSkills, agents map[string]RuntimeAgent) error {
	if strings.TrimSpace(skills.PublicDirectory) == "" || strings.TrimSpace(skills.PrivateRoot) == "" {
		return ErrInvalidRuntimeConfig
	}
	seenAgents := make(map[string]struct{}, len(skills.Agents))
	for _, policy := range skills.Agents {
		agent, exists := agents[policy.AgentID]
		if !exists || agent.Default {
			return ErrInvalidRuntimeConfig
		}
		if _, duplicate := seenAgents[policy.AgentID]; duplicate {
			return ErrInvalidRuntimeConfig
		}
		seenAgents[policy.AgentID] = struct{}{}
		seenSkills := make(map[string]struct{}, len(policy.Allowed))
		for _, grant := range policy.Allowed {
			if !validRuntimeSkillGrant(grant) {
				return ErrInvalidRuntimeConfig
			}
			switch grant.Source {
			case "system", "public", "private":
			default:
				return ErrInvalidRuntimeConfig
			}
			if _, duplicate := seenSkills[grant.Name]; duplicate {
				return ErrInvalidRuntimeConfig
			}
			seenSkills[grant.Name] = struct{}{}
		}
	}
	if len(seenAgents) != len(agents)-1 {
		return ErrInvalidRuntimeConfig
	}
	return nil
}

func validRuntimeSkillGrant(grant RuntimeSkillGrant) bool {
	if !podIDPattern.MatchString(grant.Name) || strings.TrimSpace(grant.SkillID) == "" ||
		!path.IsAbs(grant.RootPath) || grant.ScriptFiles == nil {
		return false
	}
	switch grant.EntryType {
	case "managed", "traditional-script", "traditional-prompt":
	default:
		return false
	}
	for _, file := range grant.ScriptFiles {
		cleaned := path.Clean(strings.TrimSpace(file))
		if cleaned == "." || path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
			return false
		}
	}
	return grant.EntryType != "traditional-script" || len(grant.ScriptFiles) > 0
}

func validateRuntimeMappings(config RuntimeConfigV1, agents map[string]RuntimeAgent) error {
	if config.Guard.MainAgentID != "main" || config.Guard.QuarantineProfile != DefaultQuarantineProfile {
		return ErrInvalidRuntimeConfig
	}
	sessions := make(map[string]struct{}, len(config.SessionManager.Agents))
	for _, mapping := range config.SessionManager.Agents {
		if mapping.AgentID == "main" || mapping.Workspace == "" || mapping.StoreDirectory == "" {
			return ErrInvalidRuntimeConfig
		}
		agent, exists := agents[mapping.AgentID]
		if !exists || mapping.Workspace != agent.Workspace {
			return ErrInvalidRuntimeConfig
		}
		if _, duplicate := sessions[mapping.AgentID]; duplicate {
			return ErrInvalidRuntimeConfig
		}
		sessions[mapping.AgentID] = struct{}{}
	}
	if len(sessions) != len(agents)-1 {
		return ErrInvalidRuntimeConfig
	}
	return validateGuardProfiles(config.Guard.AgentProfiles, sessions, agents)
}

func validateGuardProfiles(
	profiles []RuntimeAgentProfile, sessions map[string]struct{}, agents map[string]RuntimeAgent,
) error {
	seen := make(map[string]struct{}, len(profiles))
	for _, mapping := range profiles {
		if mapping.Profile == "" || agents[mapping.AgentID].BrowserProfile != mapping.Profile {
			return ErrInvalidRuntimeConfig
		}
		if _, exists := sessions[mapping.AgentID]; !exists {
			return ErrInvalidRuntimeConfig
		}
		if _, duplicate := seen[mapping.AgentID]; duplicate {
			return ErrInvalidRuntimeConfig
		}
		seen[mapping.AgentID] = struct{}{}
	}
	if len(seen) != len(sessions) {
		return ErrInvalidRuntimeConfig
	}
	return nil
}
