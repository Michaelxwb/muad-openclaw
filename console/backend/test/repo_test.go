package test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func newStore(t *testing.T) *repo.Store {
	t.Helper()
	s, err := repo.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestUser_CRUDAndUniqueness(t *testing.T) {
	s := newStore(t)
	u := repo.User{UserID: "alice", ImageTag: "tag:1"}
	if err := s.CreateUser(u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := s.CreateUser(u); err != repo.ErrUserExists {
		t.Fatalf("duplicate create = %v, want ErrUserExists", err)
	}

	got, err := s.GetUser("alice")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.State != "creating" {
		t.Errorf("unexpected user: %+v", got)
	}

	if err := s.UpdateUserState("alice", "running"); err != nil {
		t.Fatalf("UpdateUserState: %v", err)
	}
	got, _ = s.GetUser("alice")
	if got.State != "running" {
		t.Errorf("state = %q, want running", got.State)
	}

	list, _, _ := s.ListUsers(0, 0)
	if len(list) != 1 {
		t.Errorf("ListUsers len = %d, want 1", len(list))
	}

	if err := s.DeleteUser("alice"); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	if _, err := s.GetUser("alice"); err != repo.ErrNotFound {
		t.Errorf("after delete = %v, want ErrNotFound", err)
	}
}

func TestLLMGlobal_Upsert(t *testing.T) {
	s := newStore(t)
	if _, err := s.GetLLMGlobal(); err != repo.ErrNotFound {
		t.Fatalf("empty = %v, want ErrNotFound", err)
	}
	if err := s.SetLLMGlobal(repo.LLMGlobal{Provider: "deepseek", BaseURL: "u", APIKeyEnc: "e", Model: "m1"}); err != nil {
		t.Fatalf("SetLLMGlobal: %v", err)
	}
	if err := s.SetLLMGlobal(repo.LLMGlobal{Provider: "deepseek", BaseURL: "u", APIKeyEnc: "e2", Model: "m2"}); err != nil {
		t.Fatalf("SetLLMGlobal upsert: %v", err)
	}
	g, _ := s.GetLLMGlobal()
	if g.Model != "m2" || g.APIKeyEnc != "e2" {
		t.Errorf("upsert not applied: %+v", g)
	}
}

func TestAudit_AppendAndQuery(t *testing.T) {
	s := newStore(t)
	base := time.Now().UTC()
	_ = s.AddAudit(repo.AuditEntry{Actor: "admin", Action: "create", Target: "alice", TS: base})
	_ = s.AddAudit(repo.AuditEntry{Actor: "admin", Action: "delete", Target: "bob", TS: base.Add(time.Second)})
	_ = s.AddAudit(repo.AuditEntry{Actor: "ops", Action: "restart", Target: "carol", TS: base.Add(2 * time.Second)})

	all, _, _ := s.QueryAudit("", time.Time{}, time.Time{}, 0, 0)
	if len(all) != 3 {
		t.Fatalf("QueryAudit all = %d, want 3", len(all))
	}
	if all[0].Action != "restart" {
		t.Errorf("newest first expected, got %q", all[0].Action)
	}

	byActor, _, _ := s.QueryAudit("admin", time.Time{}, time.Time{}, 0, 0)
	if len(byActor) != 2 {
		t.Errorf("by actor = %d, want 2", len(byActor))
	}
}

func TestAdmin_BootstrapIdempotent(t *testing.T) {
	s := newStore(t)
	if err := s.CreateAdminIfAbsent(repo.Admin{Username: "root", PasswordHash: "h1"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateAdminIfAbsent(repo.Admin{Username: "root", PasswordHash: "h2"}); err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	a, err := s.GetAdmin("root")
	if err != nil {
		t.Fatalf("GetAdmin: %v", err)
	}
	if a.PasswordHash != "h1" {
		t.Errorf("hash = %q, want original h1 (ON CONFLICT DO NOTHING)", a.PasswordHash)
	}
}
