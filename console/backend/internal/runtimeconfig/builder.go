// Package runtimeconfig builds the versioned Pod runtime contract from control-plane data.
package runtimeconfig

import (
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	DefaultStateDirectory        = "/home/node/.openclaw"
	DefaultPublicSkillsDirectory = "/opt/openclaw-skills"
)

var ErrInvalidRuntimeSource = errors.New("runtimeconfig: invalid control-plane data")

// Source is the batched repository surface needed to build one Pod DTO.
type Source interface {
	GetPod(podID string) (repo.Pod, error)
	ListHumanUsersByPod(podID string, filter repo.HumanUserListFilter) ([]repo.HumanUser, int, error)
	ListIdentitiesByPod(podID string) ([]repo.UserIdentity, error)
	ListPlatformConfigs() ([]repo.PlatformConfig, error)
	ListLLMModelConfigs(filter repo.LLMModelConfigListFilter) ([]repo.LLMModelConfig, error)
	ResolveEffectiveSkills(
		cipher *secretcrypto.Cipher, humanUserID string, filter repo.EffectiveSkillFilter,
	) ([]repo.EffectiveSkill, int, error)
}

type Options struct {
	ConsoleInternalURL    string
	StateDirectory        string
	PublicSkillsDirectory string
	MaxSkillConcurrency   int
	MaxBrowserConcurrency int
}

type Result struct {
	Config        driver.RuntimeConfigV1
	CanonicalJSON []byte
	Hash          string
}

type Builder struct {
	source  Source
	cipher  *secretcrypto.Cipher
	options Options
}

type sourceData struct {
	pod        repo.Pod
	users      []repo.HumanUser
	identities []repo.UserIdentity
	platforms  []repo.PlatformConfig
	models     []repo.LLMModelConfig
}

func New(source Source, cipher *secretcrypto.Cipher, options Options) (*Builder, error) {
	if source == nil || cipher == nil || strings.TrimSpace(options.ConsoleInternalURL) == "" {
		return nil, ErrInvalidRuntimeSource
	}
	options.StateDirectory = valueOrDefault(options.StateDirectory, DefaultStateDirectory)
	options.PublicSkillsDirectory = valueOrDefault(options.PublicSkillsDirectory, DefaultPublicSkillsDirectory)
	if options.MaxSkillConcurrency <= 0 || options.MaxBrowserConcurrency <= 0 {
		return nil, ErrInvalidRuntimeSource
	}
	return &Builder{source: source, cipher: cipher, options: options}, nil
}

func (builder *Builder) Build(podID string) (Result, error) {
	data, err := builder.load(podID)
	if err != nil {
		return Result{}, err
	}
	users, err := selectRuntimeUsers(data.pod.PodID, data.users)
	if err != nil {
		return Result{}, err
	}
	routes, links, err := buildRoutesAndLinks(data.pod.PodID, users, data.identities)
	if err != nil {
		return Result{}, err
	}
	providers, models, err := builder.buildModels(data, users)
	if err != nil {
		return Result{}, err
	}
	skillPolicies, err := builder.buildSkillPolicies(users)
	if err != nil {
		return Result{}, err
	}
	platforms, err := builder.buildPlatforms(data.platforms)
	if err != nil {
		return Result{}, err
	}
	channels, err := builder.buildChannels(data.pod)
	if err != nil {
		return Result{}, err
	}
	config := builder.assemble(data.pod, users, routes, links, providers, models, platforms, channels, skillPolicies)
	return finish(config)
}

func (builder *Builder) load(podID string) (sourceData, error) {
	pod, err := builder.source.GetPod(podID)
	if err != nil {
		return sourceData{}, err
	}
	users, _, err := builder.source.ListHumanUsersByPod(podID, repo.HumanUserListFilter{})
	if err != nil {
		return sourceData{}, err
	}
	identities, err := builder.source.ListIdentitiesByPod(podID)
	if err != nil {
		return sourceData{}, err
	}
	platforms, err := builder.source.ListPlatformConfigs()
	if err != nil {
		return sourceData{}, err
	}
	models, err := builder.source.ListLLMModelConfigs(repo.LLMModelConfigListFilter{})
	if err != nil {
		return sourceData{}, err
	}
	return sourceData{
		pod: pod, users: users, identities: identities,
		platforms: platforms, models: models,
	}, nil
}

func (builder *Builder) assemble(
	pod repo.Pod, users []repo.HumanUser, routes []driver.RuntimeRoute,
	links []driver.RuntimeIdentityLink, providers []driver.RuntimeProvider,
	models map[string]string, platforms []driver.RuntimePlatform,
	channels driver.RuntimeChannels, skillPolicies []driver.RuntimeAgentSkills,
) driver.RuntimeConfigV1 {
	agents := buildAgents(builder.options.StateDirectory, users, models)
	browser, sessions, guard := buildUserMappings(builder.options.StateDirectory, users)
	maxSkills := positiveOrDefault(pod.MaxSkillConcurrency, builder.options.MaxSkillConcurrency)
	maxBrowser := positiveOrDefault(pod.MaxBrowserConcurrency, builder.options.MaxBrowserConcurrency)
	return driver.RuntimeConfigV1{
		Version: driver.RuntimeConfigVersion, PodID: pod.PodID, Generation: pod.ConfigGeneration,
		ConsoleInternalURL: strings.TrimRight(builder.options.ConsoleInternalURL, "/"),
		ServiceTokenFile:   driver.PodServiceTokenPath,
		Concurrency:        driver.RuntimeConcurrency{MaxSkills: maxSkills, MaxBrowser: maxBrowser},
		Channels:           channels,
		Agents:             agents, Routes: routes, IdentityLinks: links, Browser: browser,
		Providers: providers, Platforms: platforms,
		Skills: driver.RuntimeSkills{
			PublicDirectory: builder.options.PublicSkillsDirectory,
			PrivateRoot:     builder.options.StateDirectory,
			Agents:          skillPolicies,
		},
		SessionManager: sessions, Guard: guard,
	}
}

func (builder *Builder) buildSkillPolicies(
	users []repo.HumanUser,
) ([]driver.RuntimeAgentSkills, error) {
	policies := make([]driver.RuntimeAgentSkills, 0, len(users))
	for _, user := range users {
		effective, _, err := builder.source.ResolveEffectiveSkills(
			builder.cipher, user.HumanUserID, repo.EffectiveSkillFilter{},
		)
		if err != nil {
			return nil, err
		}
		policies = append(policies, driver.RuntimeAgentSkills{
			AgentID: user.AgentID,
			Allowed: runtimeSkillGrants(effective),
		})
	}
	return policies, nil
}

func runtimeSkillGrants(skills []repo.EffectiveSkill) []driver.RuntimeSkillGrant {
	grants := make([]driver.RuntimeSkillGrant, 0, len(skills))
	for _, skill := range skills {
		if !skill.Effective || skill.Status != repo.EffectiveSkillStatusEffective {
			continue
		}
		if skill.EntryType != "" && skill.EntryType != "script" {
			continue
		}
		grants = append(grants, driver.RuntimeSkillGrant{
			Name: skill.Name, Source: skill.EffectiveSource, SkillID: effectiveSkillID(skill),
		})
	}
	slices.SortFunc(grants, func(left, right driver.RuntimeSkillGrant) int {
		return strings.Compare(left.Name, right.Name)
	})
	return grants
}

func effectiveSkillID(skill repo.EffectiveSkill) string {
	switch skill.EffectiveSource {
	case repo.SkillScopeSystem:
		return skill.SystemSkillID
	case repo.SkillScopePrivate:
		return skill.PrivateSkillID
	default:
		return skill.PublicSkillID
	}
}

func selectRuntimeUsers(podID string, input []repo.HumanUser) ([]repo.HumanUser, error) {
	users := make([]repo.HumanUser, 0, len(input))
	for _, user := range input {
		if user.PodID != podID {
			return nil, ErrInvalidRuntimeSource
		}
		switch user.Status {
		case repo.HumanUserStatusActive, repo.HumanUserStatusPending:
			users = append(users, user)
		case repo.HumanUserStatusDisabled, repo.HumanUserStatusDeleting:
		default:
			return nil, ErrInvalidRuntimeSource
		}
	}
	slices.SortFunc(users, func(left, right repo.HumanUser) int {
		return strings.Compare(left.AgentID, right.AgentID)
	})
	return users, nil
}

func buildAgents(state string, users []repo.HumanUser, models map[string]string) []driver.RuntimeAgent {
	agents := []driver.RuntimeAgent{{
		ID: "main", Default: true, Status: repo.HumanUserStatusActive,
		Workspace: path.Join(state, "workspace"), AgentDir: path.Join(state, "agents/main/agent"),
		Model: models["main"], Tools: mainToolPolicy(),
	}}
	for _, user := range users {
		agents = append(agents, driver.RuntimeAgent{
			ID: user.AgentID, Status: user.Status,
			Workspace:      path.Join(state, "workspace-"+user.AgentID),
			AgentDir:       path.Join(state, "agents", user.AgentID, "agent"),
			BrowserProfile: user.BrowserProfile, Model: models[user.AgentID],
			Tools: businessToolPolicy(),
		})
	}
	return agents
}

func buildUserMappings(state string, users []repo.HumanUser) (
	driver.RuntimeBrowser, driver.RuntimeSessionManager, driver.RuntimeGuard,
) {
	browser := driver.RuntimeBrowser{
		DefaultProfile: driver.DefaultQuarantineProfile,
		Profiles: []driver.RuntimeBrowserProfile{{
			ID: driver.DefaultQuarantineProfile, Driver: "openclaw", CDPPort: driver.DefaultQuarantineCDPPort,
		}},
	}
	sessions := driver.RuntimeSessionManager{Agents: []driver.RuntimeSessionAgent{}}
	guard := driver.RuntimeGuard{
		MainAgentID: "main", QuarantineProfile: driver.DefaultQuarantineProfile,
		AgentProfiles: []driver.RuntimeAgentProfile{},
	}
	for _, user := range users {
		workspace := path.Join(state, "workspace-"+user.AgentID)
		browser.Profiles = append(browser.Profiles, driver.RuntimeBrowserProfile{
			ID: user.BrowserProfile, Driver: "openclaw", CDPPort: user.BrowserCDPPort,
		})
		sessions.Agents = append(sessions.Agents, driver.RuntimeSessionAgent{
			AgentID: user.AgentID, Workspace: workspace,
			StoreDirectory: path.Join(state, "agents", user.AgentID, "session-store"),
		})
		guard.AgentProfiles = append(guard.AgentProfiles, driver.RuntimeAgentProfile{
			AgentID: user.AgentID, Profile: user.BrowserProfile,
		})
	}
	return browser, sessions, guard
}

func mainToolPolicy() driver.RuntimeToolPolicy {
	return driver.RuntimeToolPolicy{
		Deny:          []string{"browser", "exec", "read", "write", "edit", "muad_run_skill", "session_get_state"},
		WorkspaceOnly: true,
	}
}

func businessToolPolicy() driver.RuntimeToolPolicy {
	return driver.RuntimeToolPolicy{
		Allow: []string{"browser", "muad_run_skill", "session_get_state"},
		Deny:  []string{"exec", "shell"}, WorkspaceOnly: true,
	}
}

func valueOrDefault(value, fallback string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return fallback
}

func positiveOrDefault(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func wrapInvalid(label string, err error) error {
	return fmt.Errorf("%w: %s: %v", ErrInvalidRuntimeSource, label, err)
}
