package test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
)

func TestRuntimeConfig_StrictRoundTrip(t *testing.T) {
	config := validRuntimeConfig()
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	decoded, err := driver.DecodeRuntimeConfig(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("DecodeRuntimeConfig: %v", err)
	}
	if decoded.PodID != "pod-a" || decoded.Agents[1].ID != "alice" {
		t.Fatalf("unexpected decoded config: %+v", decoded)
	}
}

func TestRuntimeConfig_RejectsUnknownVersionFieldAndReferences(t *testing.T) {
	tests := []string{
		`{"version":2}`,
		`{"version":1,"unknown":true}`,
		`{"version":1} {"version":1}`,
	}
	for _, raw := range tests {
		if _, err := driver.DecodeRuntimeConfig(strings.NewReader(raw)); err == nil {
			t.Fatalf("expected invalid config for %s", raw)
		}
	}

	config := validRuntimeConfig()
	config.Routes[0].AgentID = "missing"
	if err := config.Validate(); !errors.Is(err, driver.ErrInvalidRuntimeConfig) {
		t.Fatalf("missing route agent error = %v", err)
	}
	config = validRuntimeConfig()
	config.Browser.Profiles[1].CDPPort = driver.DefaultQuarantineCDPPort
	if err := config.Validate(); !errors.Is(err, driver.ErrInvalidRuntimeConfig) {
		t.Fatalf("duplicate Browser port error = %v", err)
	}
	config = validRuntimeConfig()
	config.Guard.AgentProfiles[0].Profile = "other"
	if err := config.Validate(); !errors.Is(err, driver.ErrInvalidRuntimeConfig) {
		t.Fatalf("mismatched Guard profile error = %v", err)
	}
}

func TestPodSpec_ValidatesSecretAndOmitsValueFromJSON(t *testing.T) {
	config := validRuntimeConfig()
	spec := driver.PodSpec{
		PodID: "pod-a", ImageTag: "image:test", MultiUser: config,
		Resource: driver.ResourceSpec{
			MemLimit: "4g", CPULimit: "2", RestartPolicy: "unless-stopped",
			MaxSkillConcurrency: 2, MaxBrowserConcurrency: 1,
		},
		ServiceToken: driver.SecretFileSpec{
			Name: "pod-a-service-token", ContainerPath: driver.PodServiceTokenPath,
			Value: "plain-token", Mode: 0o400,
		},
	}
	if err := spec.Validate(); err != nil {
		t.Fatalf("PodSpec.Validate: %v", err)
	}
	raw, err := json.Marshal(spec.ServiceToken)
	if err != nil {
		t.Fatalf("Marshal SecretFileSpec: %v", err)
	}
	if strings.Contains(string(raw), "plain-token") {
		t.Fatalf("SecretFileSpec JSON leaked token: %s", raw)
	}
	spec.ServiceToken.ContainerPath = "/tmp/token"
	if err := spec.Validate(); !errors.Is(err, driver.ErrInvalidPodSpec) {
		t.Fatalf("invalid secret path error = %v", err)
	}
}

func validRuntimeConfig() driver.RuntimeConfigV1 {
	return driver.RuntimeConfigV1{
		Version: driver.RuntimeConfigVersion, PodID: "pod-a", Generation: 1,
		ConsoleInternalURL: "http://console:8080", ServiceTokenFile: driver.PodServiceTokenPath,
		Concurrency: driver.RuntimeConcurrency{MaxSkills: 2, MaxBrowser: 1},
		Channels: driver.RuntimeChannels{
			Enabled: []string{"wecom"},
			Configs: map[string]json.RawMessage{"wecom": json.RawMessage(`{"botId":"test","secret":"test"}`)},
		},
		Agents: []driver.RuntimeAgent{
			{ID: "main", Default: true, Status: "active", Workspace: "/state/main/workspace", AgentDir: "/state/main/agent", Tools: driver.RuntimeToolPolicy{}},
			{ID: "alice", Status: "active", Workspace: "/state/alice/workspace", AgentDir: "/state/alice/agent", BrowserProfile: "alice", Model: "provider-a/model", Tools: driver.RuntimeToolPolicy{WorkspaceOnly: true}},
		},
		Routes: []driver.RuntimeRoute{
			{AgentID: "alice", Channel: "wecom", AccountID: "default", PeerKind: "direct", ExternalID: "alice-id"},
		},
		IdentityLinks: []driver.RuntimeIdentityLink{{AgentID: "alice", Identities: []string{"wecom:default:alice-id"}}},
		Browser: driver.RuntimeBrowser{
			DefaultProfile: driver.DefaultQuarantineProfile,
			Profiles: []driver.RuntimeBrowserProfile{
				{ID: driver.DefaultQuarantineProfile, Driver: "openclaw", CDPPort: driver.DefaultQuarantineCDPPort},
				{ID: "alice", Driver: "openclaw", CDPPort: 18802},
			},
		},
		Providers: []driver.RuntimeProvider{
			{ID: "provider-a", Provider: "deepseek", BaseURL: "https://example.invalid", APIKey: "secret", Model: "chat"},
		},
		Platforms: []driver.RuntimePlatform{{ID: "xdr", DisplayName: "XDR", Config: json.RawMessage(`{}`)}},
		Skills: driver.RuntimeSkills{
			PublicDirectory: "/opt/openclaw-skills", PrivateRoot: "/state",
			Agents: []driver.RuntimeAgentSkills{{
				AgentID: "alice",
				Allowed: []driver.RuntimeSkillGrant{{
					Name: "xdr-query", Source: "public", SkillID: "skill-public-xdr",
				}},
			}},
		},
		SessionManager: driver.RuntimeSessionManager{Agents: []driver.RuntimeSessionAgent{
			{AgentID: "alice", Workspace: "/state/alice/workspace", StoreDirectory: "/state/alice/session-store"},
		}},
		Guard: driver.RuntimeGuard{
			MainAgentID: "main", QuarantineProfile: driver.DefaultQuarantineProfile,
			AgentProfiles: []driver.RuntimeAgentProfile{{AgentID: "alice", Profile: "alice"}},
		},
	}
}
