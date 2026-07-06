package test

import (
	"context"
	"encoding/json"
	"io"
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
	// execStdinCalls captures every ExecStdin invocation for assertions on
	// hot-reload flows (PUT /containers/{userId}/channels).
	execStdinCalls []execStdinCall
	// execStdinErr, if non-nil, is returned from the next ExecStdin call.
	execStdinErr error
}

type execStdinCall struct {
	userID string
	cmd    []string
	stdin  string
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
		// Connected: wecom running + wechat configured with an account.
		return `{"channels":{"wecom":{"configured":true,"running":true,"lastStartAt":1782557888921},"openclaw-weixin":{"configured":true}},"channelAccounts":{"wecom":[],"openclaw-weixin":[{"accountId":"default"}]}}`, nil
	}
}
func (f *fakeDriver) Logs(context.Context, string, int) (string, error) {
	return "log-line\n", nil
}
func (f *fakeDriver) ExecStdin(_ context.Context, userID string, stdin io.Reader, cmd ...string) (string, error) {
	body, _ := io.ReadAll(stdin)
	f.execStdinCalls = append(f.execStdinCalls, execStdinCall{userID: userID, cmd: append([]string(nil), cmd...), stdin: string(body)})
	if f.execStdinErr != nil {
		return "", f.execStdinErr
	}
	return "ok", nil
}
func (f *fakeDriver) Reap(context.Context, string) error   { return nil }
func (f *fakeDriver) Revive(context.Context, string) error { return nil }

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

// --- TASK-003: GET /containers/{userId} + PUT /containers/{userId}/channels ---

func TestGetContainer_ReturnsDetailsAndRedactsSecret(t *testing.T) {
	e := newTestEnv(t)
	// Provision with explicit wecom creds + add a wechat channel so the
	// response shape exercises the multi-channel + secrets-mask path.
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"kim","channels":["wecom","wechat"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-7","secret":"hunter2"}}}`); rr.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rr.Code, rr.Body.String())
	}

	rr := e.do(http.MethodGet, "/api/v1/containers/kim", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("get = %d: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Data struct {
			UserID         string                            `json:"userId"`
			Channels       []string                          `json:"channels"`
			ChannelConfigs map[string]map[string]any         `json:"channelConfigs"`
			State          string                            `json:"state"`
			ImageTag       string                            `json:"imageTag"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, rr.Body.String())
	}
	if resp.Data.UserID != "kim" {
		t.Errorf("userId = %q, want kim", resp.Data.UserID)
	}
	want := []string{"wecom", "wechat"}
	if len(resp.Data.Channels) != 2 || resp.Data.Channels[0] != want[0] || resp.Data.Channels[1] != want[1] {
		t.Errorf("channels = %v, want %v", resp.Data.Channels, want)
	}
	// botId is plaintext (it's not secret), but secret must be redacted to a flag.
	wecomCfg, ok := resp.Data.ChannelConfigs["wecom"]
	if !ok {
		t.Fatalf("wecom config missing: %+v", resp.Data.ChannelConfigs)
	}
	if wecomCfg["botId"] != "wb-7" {
		t.Errorf("botId = %v, want wb-7", wecomCfg["botId"])
	}
	if wecomCfg["secretConfigured"] != true {
		t.Errorf("secretConfigured = %v, want true", wecomCfg["secretConfigured"])
	}
	if _, leaked := wecomCfg["secret"]; leaked {
		t.Error("raw secret must not be returned in GET /containers/{userId}")
	}
	// wechat block: only present if the user supplied creds for it; we didn't,
	// so it's omitted. (The block is reserved for masking, not inferred.)
	if _, ok := resp.Data.ChannelConfigs["wechat"]; ok {
		t.Errorf("wechat config should be omitted when no creds supplied; got %v", resp.Data.ChannelConfigs["wechat"])
	}
	if resp.Data.State != "running" {
		t.Errorf("state = %q, want running", resp.Data.State)
	}
}

func TestGetContainer_NotFound(t *testing.T) {
	e := newTestEnv(t)
	if rr := e.do(http.MethodGet, "/api/v1/containers/nobody", ""); rr.Code != http.StatusNotFound {
		t.Fatalf("get missing = %d, want 404", rr.Code)
	}
}

func TestUpdateChannels_HotReload(t *testing.T) {
	e := newTestEnv(t)
	// Start with wecom-only.
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"leo","channels":["wecom"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-1","secret":"s1"}}}`); rr.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rr.Code, rr.Body.String())
	}

	// Edit: append wechat, keep wecom creds unchanged.
	rr := e.do(http.MethodPut, "/api/v1/containers/leo/channels",
		`{"channels":["wecom","wechat"],`+
			`"channelConfigs":{"wecom":{"botId":"","secret":""}}}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("update = %d: %s", rr.Code, rr.Body.String())
	}

	// ExecStdin must have been called exactly once, with the right script path
	// and a stdin payload that round-trips the new channel set.
	if len(e.drv.execStdinCalls) != 1 {
		t.Fatalf("ExecStdin calls = %d, want 1", len(e.drv.execStdinCalls))
	}
	call := e.drv.execStdinCalls[0]
	if call.userID != "leo" {
		t.Errorf("ExecStdin userID = %q, want leo", call.userID)
	}
	if len(call.cmd) != 2 || call.cmd[0] != "node" || call.cmd[1] != "/opt/muad/inject-channels.mjs" {
		t.Errorf("ExecStdin cmd = %v, want [node /opt/muad/inject-channels.mjs]", call.cmd)
	}
	var stdinObj map[string]any
	if err := json.Unmarshal([]byte(call.stdin), &stdinObj); err != nil {
		t.Fatalf("stdin not JSON: %v body=%s", err, call.stdin)
	}
	if _, ok := stdinObj["wecom"]; !ok {
		t.Errorf("stdin payload missing wecom key: %v", stdinObj)
	}
	if _, ok := stdinObj["openclaw-weixin"]; !ok {
		t.Errorf("stdin payload missing wechat (openclaw-weixin) key: %v", stdinObj)
	}

	// DB now reflects the new channel set.
	u, err := e.store.GetUser("leo")
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	var stored []string
	if err := json.Unmarshal([]byte(u.Channels), &stored); err != nil {
		t.Fatalf("stored channels unmarshal: %v", err)
	}
	if len(stored) != 2 || stored[0] != "wecom" || stored[1] != "wechat" {
		t.Errorf("stored channels = %v, want [wecom wechat]", stored)
	}

	// GET should reflect the new state.
	rr = e.do(http.MethodGet, "/api/v1/containers/leo", "")
	if !strings.Contains(rr.Body.String(), `"wechat"`) {
		t.Errorf("GET response missing wechat after update: %s", rr.Body.String())
	}
}

func TestUpdateChannels_PreservesSecretWhenOmitted(t *testing.T) {
	e := newTestEnv(t)
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"mia","channels":["wecom"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-1","secret":"original-secret"}}}`); rr.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rr.Code, rr.Body.String())
	}

	// Edit: omit secret in body, change only botId → server must reuse stored secret.
	if rr := e.do(http.MethodPut, "/api/v1/containers/mia/channels",
		`{"channels":["wecom"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-2","secret":""}}}`); rr.Code != http.StatusOK {
		t.Fatalf("update = %d: %s", rr.Code, rr.Body.String())
	}

	u, _ := e.store.GetUser("mia")
	if u.BotID != "wb-2" {
		t.Errorf("botId = %q, want wb-2", u.BotID)
	}
	// Secret should still be the originally-encrypted value, not blank.
	if u.SecretEnc == "" {
		t.Error("secret lost after no-op update (was empty in body)")
	}
	// Round-trip: verify it's still the same ciphertext, not re-encrypted to "".
	beforeDec, err := decryptForTest(t, e, u.SecretEnc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if beforeDec != "original-secret" {
		t.Errorf("stored secret = %q, want original-secret (must be preserved when body omits)", beforeDec)
	}
}

func TestUpdateChannels_InvalidPayload(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"nia","botId":"b","secret":"s"}`)

	cases := []struct {
		name string
		body string
		want int
	}{
		{"empty channels", `{"channels":[]}`, http.StatusBadRequest},
		{"unknown channel", `{"channels":["telegram"]}`, http.StatusBadRequest},
		{"malformed json", `not-json`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := e.do(http.MethodPut, "/api/v1/containers/nia/channels", tc.body)
			if rr.Code != tc.want {
				t.Errorf("%s: code = %d, want %d (body=%s)", tc.name, rr.Code, tc.want, rr.Body.String())
			}
		})
	}

	// Missing user → 404 (existence check fires after JSON parse).
	if rr := e.do(http.MethodPut, "/api/v1/containers/ghost/channels",
		`{"channels":["wecom"]}`); rr.Code != http.StatusNotFound {
		t.Errorf("missing user = %d, want 404", rr.Code)
	}
}

func TestUpdateChannels_RemoveChannel(t *testing.T) {
	e := newTestEnv(t)
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"polly","channels":["wecom","wechat"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-1","secret":"s1"}}}`); rr.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rr.Code, rr.Body.String())
	}

	// Drop wechat → only wecom remains.
	if rr := e.do(http.MethodPut, "/api/v1/containers/polly/channels",
		`{"channels":["wecom"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-1","secret":""}}}`); rr.Code != http.StatusOK {
		t.Fatalf("update = %d: %s", rr.Code, rr.Body.String())
	}

	// ExecStdin fired once with payload containing only wecom.
	if len(e.drv.execStdinCalls) != 1 {
		t.Fatalf("ExecStdin calls = %d, want 1", len(e.drv.execStdinCalls))
	}
	var stdinObj map[string]any
	if err := json.Unmarshal([]byte(e.drv.execStdinCalls[0].stdin), &stdinObj); err != nil {
		t.Fatalf("stdin not JSON: %v", err)
	}
	if _, ok := stdinObj["openclaw-weixin"]; ok {
		t.Errorf("removed wechat still present in payload: %v", stdinObj)
	}
	if _, ok := stdinObj["wecom"]; !ok {
		t.Errorf("wecom missing from payload: %v", stdinObj)
	}

	// DB now stores only wecom.
	u, _ := e.store.GetUser("polly")
	var stored []string
	json.Unmarshal([]byte(u.Channels), &stored)
	if len(stored) != 1 || stored[0] != "wecom" {
		t.Errorf("stored channels = %v, want [wecom]", stored)
	}
}

func TestUpdateChannels_Noop(t *testing.T) {
	e := newTestEnv(t)
	// Establish a known-good config first.
	if rr := e.do(http.MethodPost, "/api/v1/containers",
		`{"userId":"quinn","channels":["wecom"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-1","secret":"s1"}}}`); rr.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rr.Code, rr.Body.String())
	}

	// Resubmit the exact same channels + same creds. No-op semantically,
	// but the server still re-emits the config (idempotent hot reload).
	if rr := e.do(http.MethodPut, "/api/v1/containers/quinn/channels",
		`{"channels":["wecom"],`+
			`"channelConfigs":{"wecom":{"botId":"wb-1","secret":"s1"}}}`); rr.Code != http.StatusOK {
		t.Fatalf("update = %d: %s", rr.Code, rr.Body.String())
	}

	if len(e.drv.execStdinCalls) != 1 {
		t.Fatalf("ExecStdin calls = %d, want 1 (idempotent reload)", len(e.drv.execStdinCalls))
	}
	var stdinObj map[string]any
	json.Unmarshal([]byte(e.drv.execStdinCalls[0].stdin), &stdinObj)
	wecom, _ := stdinObj["wecom"].(map[string]any)
	if wecom == nil {
		t.Fatalf("payload missing wecom: %v", stdinObj)
	}

	u, _ := e.store.GetUser("quinn")
	if u.BotID != "wb-1" {
		t.Errorf("botId drifted: %q", u.BotID)
	}
	// Secret preserved on re-submit (mergeChannelConfig: empty body means keep old).
	dec, err := decryptForTest(t, e, u.SecretEnc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if dec != "s1" {
		t.Errorf("secret = %q, want s1", dec)
	}
}

// decryptForTest pulls the cipher off the test env via reflection-free shim:
// we recreate the same cipher from the env's master key. The test harness
// keeps the key in config.Config.MasterKey; here we read it back via the
// store's encryption layer.
func decryptForTest(t *testing.T, e *testEnv, ct string) (string, error) {
	t.Helper()
	// The handler uses server.cipher (AES-GCM via crypto.New). For the test we
	// re-derive the same cipher from the same master key "mk" used in newTestEnv.
	c, err := crypto.New("mk")
	if err != nil {
		return "", err
	}
	return c.Decrypt(ct)
}
