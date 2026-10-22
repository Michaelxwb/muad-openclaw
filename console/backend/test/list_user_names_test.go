package test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type namedListItem struct {
	HumanUserID   string `json:"humanUserId"`
	HumanUserName string `json:"humanUserName"`
	Metadata      struct {
		HumanUserID string `json:"humanUserId"`
	} `json:"metadata"`
}

var namedListPaths = []string{
	"/api/v1/audit", "/api/v1/skill-executions", "/api/v1/skills?scope=private",
}

func TestListUserNamesResolveBeyondFirstUserPage(t *testing.T) {
	e := newTestEnv(t)
	createTestPod(t, e.store, "pod-a", 110)
	var user repo.HumanUser
	for index := 0; index < 101; index++ {
		agentID := fmt.Sprintf("user-%03d", index)
		var err error
		user, err = e.store.CreateHumanUser(repo.HumanUser{
			PodID: "pod-a", AgentID: agentID, DisplayName: agentID, BrowserProfile: agentID,
			ModelConfigID: createTestLLMModel(t, e.store, agentID), Status: repo.HumanUserStatusActive,
		}, 18802, 65535)
		if err != nil {
			t.Fatalf("create user %d: %v", index, err)
		}
	}
	first, total, err := e.store.ListHumanUsers(repo.HumanUserListFilter{Limit: 100})
	if err != nil || total != 101 || len(first) != 100 || first[99].HumanUserID == user.HumanUserID {
		t.Fatalf("expected target user beyond first page: %d/%d, %v", len(first), total, err)
	}
	seedNamedLists(t, e, user)
	assertNamedLists(t, e, user.HumanUserID, user.DisplayName)
}

func TestListUserNamesRefreshAfterRenameAndPreserveDeletedAuditUserID(t *testing.T) {
	e := newTestEnv(t)
	createTestPod(t, e.store, "pod-a", 2)
	user := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	seedNamedLists(t, e, user)
	assertNamedLists(t, e, user.HumanUserID, "alice")
	if err := e.store.UpdateHumanUser(user.HumanUserID, repo.HumanUserUpdate{
		DisplayName: "新的用户名", Status: repo.HumanUserStatusDisabled, ModelConfigID: user.ModelConfigID,
	}); err != nil {
		t.Fatalf("rename user: %v", err)
	}
	assertNamedLists(t, e, user.HumanUserID, "新的用户名")
	if err := e.store.MarkHumanUserDeleting(user.HumanUserID); err != nil {
		t.Fatalf("mark user deleting: %v", err)
	}
	if err := e.store.DeleteHumanUser(user.HumanUserID); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	items := readNamedList(t, e, namedListPaths[0])
	if len(items) != 1 || items[0].HumanUserName != "" || items[0].Metadata.HumanUserID != user.HumanUserID {
		t.Fatalf("deleted user audit must retain its ID with an empty name: %+v", items)
	}
}

func TestListUserNamesResolveLegacyHumanUserAuditTarget(t *testing.T) {
	e := newTestEnv(t)
	createTestPod(t, e.store, "pod-a", 1)
	user := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := e.store.AddAudit(repo.AuditEntry{
		Actor: "root", Action: "human_user.update", Target: user.HumanUserID, Payload: "ok",
	}); err != nil {
		t.Fatalf("add legacy audit: %v", err)
	}
	items := readNamedList(t, e, namedListPaths[0])
	if len(items) != 1 || items[0].HumanUserName != "alice" || items[0].Metadata.HumanUserID != user.HumanUserID {
		t.Fatalf("legacy user target = %+v", items)
	}
}

func TestListUserNamesEmptyListsReturnArrays(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range namedListPaths {
		if items := readNamedList(t, e, path); items == nil || len(items) != 0 {
			t.Fatalf("%s empty items = %+v", path, items)
		}
	}
}

func TestListUserNamesKeepOwnersOfTheSameSkillSeparate(t *testing.T) {
	e := newTestEnv(t)
	createTestPod(t, e.store, "pod-a", 2)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, e.store, "pod-a", "bob", repo.HumanUserStatusActive)
	seedNamedLists(t, e, alice)
	seedNamedLists(t, e, bob)
	for _, path := range namedListPaths {
		items := readNamedList(t, e, path)
		if len(items) != 2 {
			t.Fatalf("%s item count = %d, want 2", path, len(items))
		}
		names := make(map[string]string)
		for _, item := range items {
			id := item.HumanUserID
			if id == "" {
				id = item.Metadata.HumanUserID
			}
			names[id] = item.HumanUserName
		}
		if names[alice.HumanUserID] != "alice" || names[bob.HumanUserID] != "bob" {
			t.Fatalf("%s mixed user names: %+v", path, names)
		}
	}
}

func TestHumanUserDisplayNamesSkipBlankDuplicateAndMissingIDs(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 1)
	user := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	names, err := store.ListHumanUserDisplayNames([]string{"", user.HumanUserID, user.HumanUserID, "missing"})
	if err != nil || len(names) != 1 || names[user.HumanUserID] != "alice" {
		t.Fatalf("display names = %+v, %v", names, err)
	}
	for _, ids := range [][]string{nil, {"", ""}} {
		names, err := store.ListHumanUserDisplayNames(ids)
		if err != nil || len(names) != 0 {
			t.Fatalf("empty IDs = %+v, %v", names, err)
		}
	}
}

func seedNamedLists(t *testing.T, e *testEnv, user repo.HumanUser) {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"humanUserId": user.HumanUserID, "podId": user.PodID})
	if err != nil {
		t.Fatalf("marshal audit metadata: %v", err)
	}
	if err := e.store.AddAudit(repo.AuditEntry{
		Actor: "root", Action: "human_user.update", Target: user.HumanUserID, Payload: string(payload),
	}); err != nil {
		t.Fatalf("seed audit: %v", err)
	}
	seedSkillExecution(t, e, user, "exec-names-"+user.AgentID, "named-skill", repo.SkillScopePrivate, time.Now().UTC())
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "named-skill", Scope: repo.SkillScopePrivate, HumanUserID: user.HumanUserID,
		SourcePath: "/skills/named-skill", ManifestHash: "sha256:named-skill",
	})
}

func readNamedList(t *testing.T, e *testEnv, path string) []namedListItem {
	t.Helper()
	rr := e.do(http.MethodGet, path, "")
	assertStatus(t, rr, http.StatusOK)
	return decodeAPIData[struct {
		Items []namedListItem `json:"items"`
	}](t, rr.Body.Bytes()).Items
}

func assertNamedLists(t *testing.T, e *testEnv, userID, name string) {
	t.Helper()
	for _, path := range namedListPaths {
		items := readNamedList(t, e, path)
		if len(items) != 1 || items[0].HumanUserName != name {
			t.Fatalf("%s names = %+v, want %q", path, items, name)
		}
		item := items[0]
		if item.HumanUserID != userID && item.Metadata.HumanUserID != userID {
			t.Fatalf("%s lost original user ID %q: %+v", path, userID, item)
		}
	}
}
