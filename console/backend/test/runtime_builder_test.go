package test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
)

type runtimeBuilderSource struct {
	pod        repo.Pod
	users      []repo.HumanUser
	identities []repo.UserIdentity
	platforms  []repo.PlatformConfig
	models     []repo.LLMModelConfig
	skills     map[string][]repo.EffectiveSkill
}

func (source runtimeBuilderSource) GetPod(podID string) (repo.Pod, error) {
	if source.pod.PodID != podID {
		return repo.Pod{}, repo.ErrNotFound
	}
	return source.pod, nil
}

func (source runtimeBuilderSource) ListHumanUsersByPod(
	_ string, _ repo.HumanUserListFilter,
) ([]repo.HumanUser, int, error) {
	return source.users, len(source.users), nil
}

func (source runtimeBuilderSource) ListIdentitiesByPod(string) ([]repo.UserIdentity, error) {
	return source.identities, nil
}

func (source runtimeBuilderSource) ListPlatformConfigs() ([]repo.PlatformConfig, error) {
	return source.platforms, nil
}

func (source runtimeBuilderSource) ListLLMModelConfigs(
	_ repo.LLMModelConfigListFilter,
) ([]repo.LLMModelConfig, error) {
	return source.models, nil
}

func (source runtimeBuilderSource) ResolveEffectiveSkills(
	_ *secretcrypto.Cipher, humanUserID string, _ repo.EffectiveSkillFilter,
) ([]repo.EffectiveSkill, int, error) {
	skills := source.skills[humanUserID]
	return skills, len(skills), nil
}

func TestRuntimeBuilder_DeterministicMultiUserConfig(t *testing.T) {
	cipher := mustRuntimeCipher(t)
	source := runtimeBuilderFixture(t, cipher)
	first := buildRuntime(t, source, cipher)

	reversed := source
	reversed.users = reverseCopy(source.users)
	reversed.identities = reverseCopy(source.identities)
	reversed.platforms = reverseCopy(source.platforms)
	reversed.platforms[0].ConfigEnc = encryptRuntimeJSON(t, cipher, `{"z":1,"a":2}`)
	second := buildRuntime(t, reversed, cipher)

	if first.Hash != second.Hash || string(first.CanonicalJSON) != string(second.CanonicalJSON) {
		t.Fatalf("unordered source changed canonical output:\n%s\n%s", first.CanonicalJSON, second.CanonicalJSON)
	}
	assertRuntimeUsers(t, first.Config)
	assertRuntimeModels(t, first.Config)
	assertRuntimeSkills(t, first.Config)
	assertRuntimeRoutes(t, first.Config)
}

func TestRuntimeBuilder_RejectsInvalidStatusAndChannelAlias(t *testing.T) {
	cipher := mustRuntimeCipher(t)
	source := runtimeBuilderFixture(t, cipher)
	source.users[0].Status = "unknown"
	if _, err := newRuntimeBuilder(t, source, cipher).Build("pod-a"); !errors.Is(err, runtimeconfig.ErrInvalidRuntimeSource) {
		t.Fatalf("invalid status error = %v", err)
	}

	source = runtimeBuilderFixture(t, cipher)
	source.identities[0].OpenClawChannel = "wechat"
	if _, err := newRuntimeBuilder(t, source, cipher).Build("pod-a"); !errors.Is(err, runtimeconfig.ErrInvalidRuntimeSource) {
		t.Fatalf("invalid channel alias error = %v", err)
	}
}

func runtimeBuilderFixture(t *testing.T, cipher *secretcrypto.Cipher) runtimeBuilderSource {
	t.Helper()
	users := []repo.HumanUser{
		{HumanUserID: "u-charlie", PodID: "pod-a", ModelConfigID: "model-charlie", AgentID: "charlie", BrowserProfile: "charlie", BrowserCDPPort: 18803, Status: repo.HumanUserStatusPending},
		{HumanUserID: "u-disabled", PodID: "pod-a", AgentID: "disabled", BrowserProfile: "disabled", BrowserCDPPort: 18804, Status: repo.HumanUserStatusDisabled},
		{HumanUserID: "u-alice", PodID: "pod-a", ModelConfigID: "model-alice", AgentID: "alice", BrowserProfile: "alice", BrowserCDPPort: 18802, Status: repo.HumanUserStatusActive},
	}
	identities := []repo.UserIdentity{
		{IdentityID: "i-wechat", HumanUserID: "u-alice", PodID: "pod-a", Channel: "wechat", OpenClawChannel: "openclaw-weixin", AccountID: "default", ExternalID: "wx-alice", PeerKind: "direct", Status: repo.IdentityStatusActive},
		{IdentityID: "i-disabled", HumanUserID: "u-disabled", PodID: "pod-a", Channel: "wecom", OpenClawChannel: "wecom", AccountID: "default", ExternalID: "disabled-id", PeerKind: "direct", Status: repo.IdentityStatusActive},
		{IdentityID: "i-wecom", HumanUserID: "u-alice", PodID: "pod-a", Channel: "wecom", OpenClawChannel: "wecom", AccountID: "default", ExternalID: "XuWenBin", PeerKind: "direct", Status: repo.IdentityStatusActive},
	}
	return runtimeBuilderSource{
		pod: repo.Pod{
			PodID: "pod-a", ConfigGeneration: 9, MaxSkillConcurrency: 4,
			Channels:          `["wechat","wecom"]`,
			ChannelConfigsEnc: encryptRuntimeJSON(t, cipher, `{"wecom":{"botId":"bot-a","secret":"channel-secret"},"wechat":{}}`),
		},
		users: users, identities: identities,
		platforms: []repo.PlatformConfig{
			{Platform: "sdsp", DisplayName: "SDSP", Enabled: false},
			{Platform: "xdr", DisplayName: "XDR", Enabled: true, ConfigEnc: encryptRuntimeJSON(t, cipher, `{"a":2,"z":1}`)},
		},
		models: []repo.LLMModelConfig{
			{
				ModelConfigID: "model-alice", DisplayName: "Alice Model",
				Provider: "deepseek", BaseURL: "https://api.deepseek.com",
				Model: "deepseek-chat", APIKeyEnc: encryptRuntimeText(t, cipher, "old-key"),
			},
			{
				ModelConfigID: "model-charlie", DisplayName: "Charlie Model",
				Provider: "deepseek", BaseURL: "https://api.deepseek.com",
				Model: "deepseek-chat", APIKeyEnc: encryptRuntimeText(t, cipher, "new-key"),
			},
		},
		skills: map[string][]repo.EffectiveSkill{
			"u-alice": {
				{
					Name: "xdr-query", Effective: true, Status: repo.EffectiveSkillStatusEffective,
					EffectiveSource: repo.SkillScopePublic, PublicSkillID: "skill-public-xdr",
					EntryType: "script",
				},
				{
					Name: "web-tools-guide", Effective: true, Status: repo.EffectiveSkillStatusEffective,
					EffectiveSource: repo.SkillScopePublic, PublicSkillID: "skill-public-web",
					EntryType: "prompt-only",
				},
				{
					Name: "soar-sync", Effective: false, Status: repo.EffectiveSkillStatusConflict,
					EffectiveSource: repo.SkillScopePublic, PublicSkillID: "skill-public-soar",
					PrivateSkillID: "skill-private-soar",
				},
			},
			"u-charlie": {
				{
					Name: "sdsp-report", Effective: true, Status: repo.EffectiveSkillStatusEffective,
					EffectiveSource: repo.SkillScopePrivate, PrivateSkillID: "skill-private-sdsp",
					EntryType: "script",
				},
			},
		},
	}
}

func newRuntimeBuilder(t *testing.T, source runtimeBuilderSource, cipher *secretcrypto.Cipher) *runtimeconfig.Builder {
	t.Helper()
	builder, err := runtimeconfig.New(source, cipher, runtimeconfig.Options{
		ConsoleInternalURL:  "http://muad-console:8080/internal/v1",
		MaxSkillConcurrency: 1, MaxBrowserConcurrency: 2,
	})
	if err != nil {
		t.Fatalf("runtimeconfig.New: %v", err)
	}
	return builder
}

func buildRuntime(t *testing.T, source runtimeBuilderSource, cipher *secretcrypto.Cipher) runtimeconfig.Result {
	t.Helper()
	result, err := newRuntimeBuilder(t, source, cipher).Build("pod-a")
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return result
}

func assertRuntimeUsers(t *testing.T, config driver.RuntimeConfigV1) {
	t.Helper()
	if len(config.Agents) != 3 || config.Agents[0].ID != "main" || config.Agents[1].ID != "alice" || config.Agents[2].ID != "charlie" {
		t.Fatalf("runtime agents = %+v", config.Agents)
	}
	if config.Agents[2].Status != repo.HumanUserStatusPending {
		t.Fatalf("pending user was not pre-created: %+v", config.Agents[2])
	}
	if len(config.SessionManager.Agents) != 2 || len(config.Guard.AgentProfiles) != 2 {
		t.Fatalf("runtime mappings missing: %+v / %+v", config.SessionManager, config.Guard)
	}
	if config.Concurrency.MaxSkills != 4 || config.Concurrency.MaxBrowser != 2 {
		t.Fatalf("effective concurrency = %+v", config.Concurrency)
	}
	if !slices.Equal(config.Channels.Enabled, []string{"wechat", "wecom"}) ||
		string(config.Channels.Configs["wecom"]) != `{"botId":"bot-a","secret":"channel-secret"}` {
		t.Fatalf("runtime channels = %+v", config.Channels)
	}
}

func assertRuntimeModels(t *testing.T, config driver.RuntimeConfigV1) {
	t.Helper()
	providers := make(map[string]driver.RuntimeProvider, len(config.Providers))
	for _, provider := range config.Providers {
		providers[provider.ID] = provider
	}
	aliceID := strings.SplitN(config.Agents[1].Model, "/", 2)[0]
	charlieID := strings.SplitN(config.Agents[2].Model, "/", 2)[0]
	if aliceID == charlieID || providers[aliceID].APIKey != "old-key" || providers[charlieID].APIKey != "new-key" {
		t.Fatalf("per-user providers were mixed: %+v", config.Providers)
	}
}

func assertRuntimeSkills(t *testing.T, config driver.RuntimeConfigV1) {
	t.Helper()
	if len(config.Skills.Agents) != 2 || config.Skills.Agents[0].AgentID != "alice" ||
		config.Skills.Agents[1].AgentID != "charlie" {
		t.Fatalf("runtime Skill policies = %+v", config.Skills.Agents)
	}
	alice := config.Skills.Agents[0].Allowed
	if len(alice) != 1 || alice[0].Name != "xdr-query" ||
		alice[0].Source != repo.SkillScopePublic || alice[0].SkillID != "skill-public-xdr" {
		t.Fatalf("alice Skill grants = %+v", alice)
	}
	charlie := config.Skills.Agents[1].Allowed
	if len(charlie) != 1 || charlie[0].Name != "sdsp-report" ||
		charlie[0].Source != repo.SkillScopePrivate || charlie[0].SkillID != "skill-private-sdsp" {
		t.Fatalf("charlie Skill grants = %+v", charlie)
	}
}

func assertRuntimeRoutes(t *testing.T, config driver.RuntimeConfigV1) {
	t.Helper()
	if len(config.Routes) != 2 || config.Routes[0].Channel != "openclaw-weixin" || config.Routes[1].Channel != "wecom" {
		t.Fatalf("runtime routes = %+v", config.Routes)
	}
	if len(config.IdentityLinks) != 1 || !slices.Equal(config.IdentityLinks[0].Identities, []string{"openclaw-weixin:wx-alice", "wecom:XuWenBin"}) {
		t.Fatalf("identityLinks = %+v", config.IdentityLinks)
	}
	if len(config.Platforms) != 1 || string(config.Platforms[0].Config) != `{"a":2,"z":1}` {
		t.Fatalf("platform config = %+v", config.Platforms)
	}
}

func mustRuntimeCipher(t *testing.T) *secretcrypto.Cipher {
	t.Helper()
	cipher, err := secretcrypto.New("runtime-builder-test")
	if err != nil {
		t.Fatalf("crypto.New: %v", err)
	}
	return cipher
}

func encryptRuntimeJSON(t *testing.T, cipher *secretcrypto.Cipher, value string) string {
	t.Helper()
	if !json.Valid([]byte(value)) {
		t.Fatalf("invalid fixture JSON: %s", value)
	}
	return encryptRuntimeText(t, cipher, value)
}

func encryptRuntimeText(t *testing.T, cipher *secretcrypto.Cipher, value string) string {
	t.Helper()
	encrypted, err := cipher.Encrypt(value)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	return encrypted
}

func reverseCopy[T any](input []T) []T {
	output := append([]T(nil), input...)
	slices.Reverse(output)
	return output
}
