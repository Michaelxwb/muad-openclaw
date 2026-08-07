package repo

import "testing"

// TestAttachUsersReconcilesStatusFromIdentities guards the Pod-delete/recreate
// path: attach reconciles the user's lifecycle status against its active
// identities alone (identities are user-owned and survive Pod deletion), so the
// target Pod's channel set must not downgrade an already-active user to pending.
func TestAttachUsersReconcilesStatusFromIdentities(t *testing.T) {
	tests := []struct {
		name           string
		podChannels    string // JSON array as stored in pods.channels
		identityStatus string
		userStatus     string // optional: override user status before attach
		wantStatus     string
	}{
		{
			name:        "active identity survives empty Pod channels",
			podChannels: `[]`,
			wantStatus:  HumanUserStatusActive,
		},
		{
			name:        "active identity survives Pod channels that exclude its channel",
			podChannels: `["telegram"]`,
			wantStatus:  HumanUserStatusActive,
		},
		{
			name:        "active identity on a Pod-enabled channel stays active",
			podChannels: `["mm"]`,
			wantStatus:  HumanUserStatusActive,
		},
		{
			name:           "no active identity becomes pending",
			podChannels:    `["mm"]`,
			identityStatus: IdentityStatusDisabled,
			wantStatus:     HumanUserStatusPending,
		},
		{
			name:        "disabled user stays disabled on attach",
			podChannels: `["mm"]`,
			userStatus:  HumanUserStatusDisabled,
			wantStatus:  HumanUserStatusDisabled,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := newPodTestStore(t)
			model := createTestModel(t, store)
			pod := Pod{PodID: "pod-a", DisplayName: "A", ServiceTokenEnc: "enc",
				ServiceTokenFingerprint: "sha256:a", Channels: tc.podChannels}
			if err := store.CreatePod(pod); err != nil {
				t.Fatalf("CreatePod: %v", err)
			}

			user := HumanUser{
				PodID: "pod-a", ModelConfigID: model.ModelConfigID,
				DisplayName: "Alice", AgentID: "alice-1", BrowserProfile: "alice-1",
			}
			identity := UserIdentity{
				Channel: "mm", OpenClawChannel: "mattermost",
				ExternalID: "U-1", ExternalIDType: "mm-user", Status: tc.identityStatus,
			}
			created, err := store.CreateHumanUserWithIdentity(user, identity, 0, 0)
			if err != nil {
				t.Fatalf("CreateHumanUserWithIdentity: %v", err)
			}
			if tc.userStatus != "" {
				if _, err := store.db.Exec(`UPDATE human_users SET status = ?
					WHERE human_user_id = ?`, tc.userStatus, created.HumanUser.HumanUserID); err != nil {
					t.Fatalf("override user status: %v", err)
				}
			}

			// Simulate Pod deletion: unbound but status preserved, as
			// detachPodUsersTx does.
			if _, err := store.db.Exec(`UPDATE human_users SET pod_id = NULL,
				browser_cdp_port = 0 WHERE human_user_id = ?`, created.HumanUser.HumanUserID); err != nil {
				t.Fatalf("detach user: %v", err)
			}

			attached, err := store.AttachUsers([]string{created.HumanUser.HumanUserID}, "pod-a", 0, 0)
			if err != nil {
				t.Fatalf("AttachUsers: %v", err)
			}
			if len(attached) != 1 || attached[0].Status != tc.wantStatus {
				t.Fatalf("attached status = %q, want %q (user %+v)", attached[0].Status, tc.wantStatus, attached[0])
			}
		})
	}
}

func createTestModel(t *testing.T, store *Store) LLMModelConfig {
	t.Helper()
	models, err := store.CreateLLMModelConfigs([]LLMModelConfigCreate{{
		DisplayName: "omni", Provider: "vllm", BaseURL: "http://10.0.0.1:8000",
		APIKey: "k", Model: "omni-model",
	}})
	if err != nil {
		t.Fatalf("CreateLLMModelConfigs: %v", err)
	}
	return models[0]
}
