package test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/api"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// fakeDriver records calls so handler logic is testable without Docker.
type fakeDriver struct {
	created   map[string]driver.UserSpec
	removed   map[string]bool
	restarted map[string]int
	// channelDisconnected makes `channels status` report no linked account,
	// so the QR handler triggers a login. Default (false) = connected.
	channelDisconnected bool
}

func newFakeDriver() *fakeDriver {
	return &fakeDriver{created: map[string]driver.UserSpec{}, removed: map[string]bool{}, restarted: map[string]int{}}
}

func (f *fakeDriver) Create(_ context.Context, spec driver.UserSpec, _ string) error {
	f.created[spec.UserID] = spec
	delete(f.removed, spec.UserID)
	return nil
}
func (f *fakeDriver) Start(context.Context, string) error { return nil }
func (f *fakeDriver) Stop(context.Context, string) error  { return nil }
func (f *fakeDriver) Restart(_ context.Context, userID string) error {
	f.restarted[userID]++
	return nil
}
func (f *fakeDriver) Remove(_ context.Context, userID string, _ bool) error {
	f.removed[userID] = true
	return nil
}
func (f *fakeDriver) List(context.Context) ([]driver.ContainerInfo, error) {
	var out []driver.ContainerInfo
	for id := range f.created {
		if !f.removed[id] {
			out = append(out, driver.ContainerInfo{UserID: id, State: "running"})
		}
	}
	return out, nil
}
func (f *fakeDriver) Stats(context.Context, string) (driver.Stats, error) {
	return driver.Stats{}, nil
}
func (f *fakeDriver) StatsAll(context.Context) (map[string]driver.Stats, error) {
	out := map[string]driver.Stats{}
	for id := range f.created {
		if !f.removed[id] {
			out[id] = driver.Stats{CPUPercent: 1.5, MemMiB: 200}
		}
	}
	return out, nil
}
func (f *fakeDriver) Exec(_ context.Context, _ string, cmd ...string) (string, error) {
	joined := strings.Join(cmd, " ")
	switch {
	case strings.Contains(joined, "channels login"):
		// QR login: ASCII QR + fallback URL.
		return "用手机微信扫描以下二维码，以继续连接：\n[QR]\n" +
			"https://liteapp.weixin.qq.com/q/AbC123?qrcode=deadbeef&bot_type=3\n正在等待操作...\n", nil
	case strings.Contains(joined, "channels logs"):
		// Gateway channel logs (conversation records).
		return "log-line\n[openclaw-weixin] message handled\n", nil
	default:
		// `openclaw channels status --json`.
		if f.channelDisconnected {
			return `{"channels":{"openclaw-weixin":{"configured":false}},"channelAccounts":{"openclaw-weixin":[]}}`, nil
		}
		// wecom long-connection shape: running + lastStartAt (no inbound/outbound).
		return `{"channels":{"wecom":{"configured":true,"running":true,"lastStartAt":1782557888921}},"channelAccounts":{"wecom":[]}}`, nil
	}
}
func (f *fakeDriver) Logs(context.Context, string, int) (string, error) {
	return "log-line\n", nil
}
func (f *fakeDriver) Reap(context.Context, string) error                { return nil }
func (f *fakeDriver) Revive(context.Context, string) error              { return nil }

type testEnv struct {
	h     http.Handler
	store *repo.Store
	drv   *fakeDriver
	cache *monitor.Cache
	token string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	store := newStore(t)
	cfg := &config.Config{JWTSecret: "test-secret", DefaultImage: "img:test"}
	cipher, _ := crypto.New("mk")
	drv := newFakeDriver()
	cache := monitor.NewCache()
	if err := api.BootstrapAdmin(store, "root", "pw"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	h := api.NewServer(cfg, store, cipher, drv, cache).Handler()
	return &testEnv{h: h, store: store, drv: drv, cache: cache, token: login(t, h)}
}

func login(t *testing.T, h http.Handler) string {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"username":"root","password":"pw"}`)))
	if rr.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	return resp.Data.Token
}

func (e *testEnv) do(method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.token)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	return rr
}

func TestLoginAndProtectedRoute(t *testing.T) {
	e := newTestEnv(t)

	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no-token /me = %d, want 401", rr.Code)
	}
	if rr = e.do(http.MethodGet, "/api/v1/me", ""); rr.Code != http.StatusOK {
		t.Fatalf("authed /me = %d, want 200", rr.Code)
	}
}

func TestCreateContainer_Lifecycle(t *testing.T) {
	e := newTestEnv(t)

	rr := e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"wb-1","secret":"s"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rr.Code, rr.Body.String())
	}
	if _, ok := e.drv.created["alice"]; !ok {
		t.Fatal("driver.Create not called for alice")
	}
	u, err := e.store.GetUser("alice")
	if err != nil || u.State != "running" {
		t.Fatalf("user after create = %+v, %v", u, err)
	}
	if u.SecretEnc == "s" {
		t.Error("secret stored in plaintext")
	}

	if rr = e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"x","secret":"y"}`); rr.Code != http.StatusConflict {
		t.Fatalf("duplicate create = %d, want 409", rr.Code)
	}

	rr = e.do(http.MethodGet, "/api/v1/containers", "")
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "alice") {
		t.Fatalf("list = %d body=%s", rr.Code, rr.Body.String())
	}

	if rr = e.do(http.MethodGet, "/api/v1/containers/alice/logs?tail=10", ""); !strings.Contains(rr.Body.String(), "log-line") {
		t.Fatalf("logs body=%s", rr.Body.String())
	}

	if rr = e.do(http.MethodDelete, "/api/v1/containers/alice", ""); rr.Code != http.StatusOK {
		t.Fatalf("delete = %d", rr.Code)
	}
	if !e.drv.removed["alice"] {
		t.Error("driver.Remove not called")
	}
	if _, err := e.store.GetUser("alice"); err != repo.ErrNotFound {
		t.Errorf("user not deleted: %v", err)
	}
}

func TestCreateContainer_InvalidUserID(t *testing.T) {
	e := newTestEnv(t)
	if rr := e.do(http.MethodPost, "/api/v1/containers", `{"userId":"bad id!","botId":"b","secret":"s"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("invalid userId = %d, want 400", rr.Code)
	}
}

func TestListContainers_MergesCache(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"bob","botId":"b","secret":"s"}`)
	e.cache.Replace(map[string]monitor.Snapshot{
		"bob": {CPUPercent: 5.5, MemMiB: 300, ChannelConnected: true, Healthy: true, LastActiveAt: time.Now()},
	})

	rr := e.do(http.MethodGet, "/api/v1/containers", "")
	if !strings.Contains(rr.Body.String(), `"memMiB":300`) || !strings.Contains(rr.Body.String(), `"channelConnected":true`) {
		t.Fatalf("cache metrics not merged: %s", rr.Body.String())
	}
}

func TestCreateContainer_Channel(t *testing.T) {
	e := newTestEnv(t)

	// Explicit wechat channel persists and threads into the driver spec.
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"dave","channel":"wechat","botId":"b","secret":"s"}`); rr.Code != http.StatusOK {
		t.Fatalf("create wechat = %d: %s", rr.Code, rr.Body.String())
	}
	if got := e.drv.created["dave"].Channel; got != "wechat" {
		t.Errorf("spec channel = %q, want wechat", got)
	}
	u, _ := e.store.GetUser("dave")
	if u.Channel != "wechat" {
		t.Errorf("stored channel = %q, want wechat", u.Channel)
	}

	// Omitted channel defaults to wecom.
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"erin","botId":"b","secret":"s"}`)
	if got := e.drv.created["erin"].Channel; got != "wecom" {
		t.Errorf("default channel = %q, want wecom", got)
	}

	// Invalid channel rejected.
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"frank","channel":"telegram","botId":"b","secret":"s"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("invalid channel = %d, want 400", rr.Code)
	}
}

func TestCreateContainer_WeChatNoCreds(t *testing.T) {
	e := newTestEnv(t)

	// WeChat needs no botId/secret (login via QR from logs).
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"grace","channel":"wechat"}`); rr.Code != http.StatusOK {
		t.Fatalf("create wechat no-creds = %d: %s", rr.Code, rr.Body.String())
	}

	// WeCom still requires creds.
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"heidi","channel":"wecom"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("wecom without creds = %d, want 400", rr.Code)
	}
}

func TestQRCode_TriggersLoginWhenDisconnected(t *testing.T) {
	e := newTestEnv(t)
	e.drv.channelDisconnected = true // not logged in yet → QR expected
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"ivan","channel":"wechat"}`)

	rr := e.do(http.MethodGet, "/api/v1/containers/ivan/qrcode", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("qrcode = %d: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "weixin.qq.com") {
		t.Fatalf("expected login url in qrcode response: %s", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"connected":false`) {
		t.Fatalf("expected connected=false: %s", rr.Body.String())
	}
}

func TestQRCode_SkipsLoginWhenConnected(t *testing.T) {
	e := newTestEnv(t)
	// default fakeDriver: channels status reports a linked account → connected.
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"jane","channel":"wechat"}`)

	rr := e.do(http.MethodGet, "/api/v1/containers/jane/qrcode", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("qrcode = %d: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"connected":true`) {
		t.Fatalf("expected connected=true: %s", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "weixin.qq.com") {
		t.Fatalf("should NOT trigger login/QR when already connected: %s", rr.Body.String())
	}
}

func TestListContainers_MissingWhenContainerGone(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"ghost","botId":"b","secret":"s"}`)
	// Container removed out-of-band (e.g. `docker rm`) while the DB record stays.
	e.drv.removed["ghost"] = true

	rr := e.do(http.MethodGet, "/api/v1/containers", "")
	if !strings.Contains(rr.Body.String(), `"state":"missing"`) {
		t.Fatalf("expected missing state for orphaned record: %s", rr.Body.String())
	}

	// Deleting the orphan still works (driver.Remove is idempotent in real docker).
	if rr := e.do(http.MethodDelete, "/api/v1/containers/ghost", ""); rr.Code != http.StatusOK {
		t.Fatalf("delete orphan = %d, want 200", rr.Code)
	}
	if _, err := e.store.GetUser("ghost"); err != repo.ErrNotFound {
		t.Errorf("orphan DB record not deleted: %v", err)
	}
}

func TestReadsNotAudited(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodGet, "/api/v1/me", "")
	entries, _, _ := e.store.QueryAudit("", time.Time{}, time.Time{}, 0, 0)
	if len(entries) != 0 {
		t.Errorf("GET should not be audited, got %d", len(entries))
	}
}

func TestMutationsAudited(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"carol","botId":"b","secret":"s"}`)
	entries, _, _ := e.store.QueryAudit("root", time.Time{}, time.Time{}, 0, 0)
	if len(entries) == 0 {
		t.Fatal("expected create to be audited")
	}
}
