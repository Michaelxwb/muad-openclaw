package test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
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
	mu                sync.Mutex
	created           map[string]driver.PodSpec
	removed           map[string]bool
	keepState         map[string]bool
	restarted         map[string]int
	createErr         error
	createErrors      []error
	listErr           error
	removeErr         error
	restartErrors     map[string]error
	channelLogsOutput string
	channelLogsErr    error
	logsOutput        string
	logsErr           error
	cleanupErr        error
	execCalls         []execCall
	// channelDisconnected makes `channels status` report no linked account,
	// so the QR handler triggers a login. Default (false) = connected.
	channelDisconnected bool
	// execStdinCalls captures every ExecStdin invocation for assertions on
	// hot-reload flows (PUT /containers/{userId}/channels).
	execStdinCalls []execStdinCall
	// execStdinErr, if non-nil, is returned from the next ExecStdin call.
	execStdinErr error
	// updateSpecCalls captures every UpdateSpec invocation for assertions on
	// the secret sync side-effect of handleUpdateChannels.
	updateSpecCalls []updateSpecCall
	// updateSpecErr, if non-nil, is returned from the next UpdateSpec call.
	updateSpecErr         error
	serviceTokens         map[string]driver.SecretFileSpec
	updateServiceTokenErr error
	syncPublicSkillCalls  []syncPublicSkillCall
	syncPublicSkillErr    error
	publicSkillStorage    driver.PublicSkillsStorageStatus
	publicSkillStorageErr error
	startErr              error
	stopErr               error
	startErrors           []error
	startCalls            int
	stopCalls             int
}

type updateSpecCall struct {
	userID       string
	channels     []string
	spec         driver.PodSpec
	gatewayToken string
}

type execStdinCall struct {
	userID string
	cmd    []string
	stdin  string
}

type execCall struct {
	podID string
	cmd   []string
}

type syncPublicSkillCall struct {
	podID            string
	sourceDir        string
	sourceSkillNames []string
	sourceIndex      string
}

func newFakeDriver() *fakeDriver {
	return &fakeDriver{
		created: map[string]driver.PodSpec{}, removed: map[string]bool{}, restarted: map[string]int{},
		keepState: map[string]bool{}, restartErrors: map[string]error{},
		serviceTokens: map[string]driver.SecretFileSpec{},
		publicSkillStorage: driver.PublicSkillsStorageStatus{
			Driver: "docker", Name: "test-skills", Configured: true, Ready: true, Phase: "directory",
		},
	}
}

func (f *fakeDriver) Create(_ context.Context, spec driver.PodSpec) error {
	if len(f.createErrors) > 0 {
		err := f.createErrors[0]
		f.createErrors = f.createErrors[1:]
		if err != nil {
			return err
		}
	}
	if f.createErr != nil {
		return f.createErr
	}
	f.created[spec.PodID] = spec
	delete(f.removed, spec.PodID)
	return nil
}
func (f *fakeDriver) Start(context.Context, string) error {
	f.startCalls++
	if len(f.startErrors) > 0 {
		err := f.startErrors[0]
		f.startErrors = f.startErrors[1:]
		return err
	}
	return f.startErr
}
func (f *fakeDriver) Stop(context.Context, string) error {
	f.stopCalls++
	return f.stopErr
}
func (f *fakeDriver) Restart(_ context.Context, userID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarted[userID]++
	if err := f.restartErrors[userID]; err != nil {
		return err
	}
	return nil
}
func (f *fakeDriver) Remove(_ context.Context, userID string, keepState bool) error {
	if f.removeErr != nil {
		return f.removeErr
	}
	f.removed[userID] = true
	f.keepState[userID] = keepState
	return nil
}
func (f *fakeDriver) List(context.Context) ([]driver.ContainerInfo, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []driver.ContainerInfo
	for id := range f.created {
		if !f.removed[id] {
			out = append(out, driver.ContainerInfo{PodID: id, UserID: id, State: "running"})
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
func (f *fakeDriver) Exec(_ context.Context, podID string, cmd ...string) (string, error) {
	joined := strings.Join(cmd, " ")
	f.mu.Lock()
	f.execCalls = append(f.execCalls, execCall{podID: podID, cmd: append([]string(nil), cmd...)})
	cleanupErr := f.cleanupErr
	f.mu.Unlock()
	switch {
	case strings.Contains(joined, "muad-user-cleanup"):
		if cleanupErr != nil {
			return "", cleanupErr
		}
		return "cleaned", nil
	case strings.Contains(joined, "channels login"):
		// QR login: ASCII QR + fallback URL.
		return "用手机微信扫描以下二维码，以继续连接：\n[QR]\n" +
			"https://liteapp.weixin.qq.com/q/AbC123?qrcode=deadbeef&bot_type=3\n正在等待操作...\n", nil
	case strings.Contains(joined, "channels logs"):
		if f.channelLogsErr != nil {
			return "", f.channelLogsErr
		}
		if f.channelLogsOutput != "" {
			return f.channelLogsOutput, nil
		}
		// Gateway channel logs (conversation records).
		return "log-line\n[openclaw-weixin] message handled\n", nil
	case strings.Contains(joined, "muad.runtime.health"):
		generation := f.created[podID].MultiUser.Generation
		if generation == 0 {
			generation = 3
		}
		return fmt.Sprintf(`{"ok":true,"generation":%d,"skill":{"active":1,"queued":2},"browser":{"active":1,"queued":0},"telemetry":{"loaded":true,"pending":2,"writeFailed":false,"dropped":0,"lastError":""}}`, generation), nil
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
	if f.logsErr != nil {
		return "", f.logsErr
	}
	if f.logsOutput != "" {
		return f.logsOutput, nil
	}
	return "log-line\n", nil
}
func (f *fakeDriver) ExecStdin(_ context.Context, userID string, stdin io.Reader, cmd ...string) (string, error) {
	body, _ := io.ReadAll(stdin)
	f.execStdinCalls = append(f.execStdinCalls, execStdinCall{userID: userID, cmd: append([]string(nil), cmd...), stdin: string(body)})
	if f.execStdinErr != nil {
		return "", f.execStdinErr
	}
	joined := strings.Join(cmd, " ")
	if strings.Contains(joined, "/opt/muad/private-skill-installer.mjs install") {
		name := "xdr-private"
		for i, value := range cmd {
			if value == "--expected-name" && i+1 < len(cmd) {
				name = cmd[i+1]
			}
		}
		return fmt.Sprintf(`{"ok":true,"name":%q,"version":"1.0.0",`+
			`"platforms":["xdr"],"progressSupported":true,"browserRequired":false,`+
			`"entryType":"managed","manifestHash":"sha256:test","manifestJson":"{}",`+
			`"targetDir":"/home/node/.openclaw/workspace-agent/skills/%s"}`, name, name), nil
	}
	if strings.Contains(joined, "/opt/muad/private-skill-installer.mjs delete") {
		return `{"ok":true,"deleted":true}`, nil
	}
	return "ok", nil
}
func (f *fakeDriver) Reap(context.Context, string) error   { return nil }
func (f *fakeDriver) Revive(context.Context, string) error { return nil }
func (f *fakeDriver) UpdateSpec(_ context.Context, userID string, spec driver.PodSpec) error {
	f.updateSpecCalls = append(f.updateSpecCalls, updateSpecCall{
		userID:       userID,
		channels:     spec.Channels,
		spec:         spec,
		gatewayToken: spec.GatewayToken,
	})
	if f.updateSpecErr != nil {
		return f.updateSpecErr
	}
	return nil
}

func (f *fakeDriver) UpdateServiceToken(_ context.Context, podID string, secret driver.SecretFileSpec) error {
	if f.updateServiceTokenErr != nil {
		return f.updateServiceTokenErr
	}
	f.serviceTokens[podID] = secret
	return nil
}

func (f *fakeDriver) SyncPublicSkills(_ context.Context, podID, sourceDir string) error {
	f.syncPublicSkillCalls = append(f.syncPublicSkillCalls, syncPublicSkillCall{
		podID: podID, sourceDir: sourceDir, sourceSkillNames: snapshotSourceSkillNames(sourceDir),
		sourceIndex: snapshotSourceIndex(sourceDir),
	})
	return f.syncPublicSkillErr
}

func snapshotSourceSkillNames(sourceDir string) []string {
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(sourceDir, entry.Name(), "SKILL.md")); err == nil {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func snapshotSourceIndex(sourceDir string) string {
	body, err := os.ReadFile(filepath.Join(sourceDir, ".muad-public-index"))
	if err != nil {
		return ""
	}
	return string(body)
}

func (f *fakeDriver) PublicSkillsStorageStatus(context.Context) (driver.PublicSkillsStorageStatus, error) {
	return f.publicSkillStorage, f.publicSkillStorageErr
}

func (f *fakeDriver) EnsurePublicSkillsStorage(context.Context) (driver.PublicSkillsStorageStatus, error) {
	if f.publicSkillStorageErr != nil {
		return driver.PublicSkillsStorageStatus{}, f.publicSkillStorageErr
	}
	f.publicSkillStorage.Ready = true
	f.publicSkillStorage.Phase = "Bound"
	return f.publicSkillStorage, nil
}

type testEnv struct {
	h         http.Handler
	store     *repo.Store
	drv       *fakeDriver
	cache     *monitor.Cache
	reconcile *fakeReconcileQueue
	token     string
	skillsDir string
}

type fakeReconcileQueue struct{ podIDs []string }

func (queue *fakeReconcileQueue) Enqueue(podID string) {
	queue.podIDs = append(queue.podIDs, podID)
}

func (queue *fakeReconcileQueue) RunExclusive(
	ctx context.Context, _ string, operation func(context.Context) error,
) error {
	return operation(ctx)
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	store := newStore(t)
	skillsDir := t.TempDir()
	cfg := &config.Config{
		MasterKey: "mk", JWTSecret: "test-secret", DefaultImage: "img:test",
		ConsoleInternalURL: "http://console.internal:8080", SkillsDir: skillsDir,
		RuntimeStateDir: "/home/node/.openclaw", RuntimePublicSkillsDir: "/opt/openclaw-skills",
		RuntimeDefaults: config.RuntimeDefaults{
			MemLimit: "3g", CPULimit: "2", RestartPolicy: "unless-stopped",
			MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1,
			BrowserCDPPortStart: 18802, BrowserCDPPortEnd: 65535,
		},
	}
	cipher, _ := crypto.New("mk")
	drv := newFakeDriver()
	cache := monitor.NewCache()
	reconcile := &fakeReconcileQueue{}
	if err := api.BootstrapAdmin(store, "root", "pw"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	h := api.NewServer(cfg, store, cipher, drv, cache, reconcile).Handler()
	return &testEnv{
		h: h, store: store, drv: drv, cache: cache, reconcile: reconcile,
		token: login(t, h), skillsDir: skillsDir,
	}
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

func TestPodAPIRejectsInvalidPodID(t *testing.T) {
	e := newTestEnv(t)
	rr := e.do(http.MethodPost, "/api/v1/containers", `{"podId":"bad id!","channels":["wechat"]}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("invalid podId status = %d, want 400", rr.Code)
	}
}

func TestPodListMergesRuntimeMetrics(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-metrics")
	e.cache.Replace(map[string]monitor.Snapshot{
		"pod-metrics": {
			CPUPercent: 5.5, MemMiB: 300, ChannelStatuses: map[string]bool{"wechat": true},
			SkillActive: 2, BrowserQueued: 1, RuntimeGuardHealthy: true,
		},
	})
	rr := e.do(http.MethodGet, "/api/v1/containers", "")
	for _, expected := range []string{`"memMiB":300`, `"skillActive":2`, `"browserQueued":1`, `"wechat":true`} {
		if !strings.Contains(rr.Body.String(), expected) {
			t.Fatalf("Pod metrics response missing %s: %s", expected, rr.Body.String())
		}
	}
}

func TestPodChannelValidation(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-wechat")
	if got := e.drv.created["pod-wechat"].Channels; len(got) != 1 || got[0] != "wechat" {
		t.Fatalf("driver channels = %v, want [wechat]", got)
	}
	cases := []struct {
		name string
		body string
	}{
		{"unsupported", `{"podId":"pod-unsupported","channels":["telegram"]}`},
		{"wecom without credentials", `{"podId":"pod-wecom","channels":["wecom"]}`},
		{"wechat with credentials", `{"podId":"pod-wx-creds","channels":["wechat"],"channelConfigs":{"wechat":{"botId":"bad"}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if rr := e.do(http.MethodPost, "/api/v1/containers", tc.body); rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestPodListReportsMissingRuntime(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-missing")
	e.drv.removed["pod-missing"] = true
	rr := e.do(http.MethodGet, "/api/v1/containers", "")
	if !strings.Contains(rr.Body.String(), `"state":"missing"`) {
		t.Fatalf("missing runtime state not reported: %s", rr.Body.String())
	}
	if rr = e.do(http.MethodDelete, "/api/v1/containers/pod-missing?deleteState=true", ""); rr.Code != http.StatusOK {
		t.Fatalf("delete missing Pod = %d: %s", rr.Code, rr.Body.String())
	}
	if _, err := e.store.GetPod("pod-missing"); err != repo.ErrNotFound {
		t.Fatalf("missing Pod row was not deleted: %v", err)
	}
}

func TestReadsNotAudited(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodGet, "/api/v1/me", "")
	entries, _, err := e.store.QueryAudit("", time.Time{}, time.Time{}, 0, 0)
	if err != nil || len(entries) != 0 {
		t.Fatalf("GET audit entries = %d, error = %v", len(entries), err)
	}
}

func TestPodMutationIsAudited(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-audit")
	entries, _, err := e.store.QueryAudit("root", time.Time{}, time.Time{}, 0, 0)
	if err != nil || len(entries) == 0 {
		t.Fatalf("Pod mutation audit entries = %d, error = %v", len(entries), err)
	}
}

func TestPodChannelUpdateRemovesChannelAndQueuesReconcile(t *testing.T) {
	e := newTestEnv(t)
	body := `{"podId":"pod-channels","channels":["wecom","wechat"],` +
		`"channelConfigs":{"wecom":{"botId":"bot-old","secret":"secret-old"}}}`
	createPodThroughAPI(t, e, body)
	before, err := e.store.GetPod("pod-channels")
	if err != nil {
		t.Fatalf("get Pod before update: %v", err)
	}
	e.reconcile.podIDs = nil
	rr := e.do(http.MethodPut, "/api/v1/containers/pod-channels/channels",
		`{"channels":["wecom"],"channelConfigs":{"wecom":{"botId":"bot-new"}}}`)
	if rr.Code != http.StatusOK || strings.Contains(rr.Body.String(), "secret-old") {
		t.Fatalf("channel update = %d: %s", rr.Code, rr.Body.String())
	}
	after, err := e.store.GetPod("pod-channels")
	if err != nil {
		t.Fatalf("get Pod after update: %v", err)
	}
	if after.ConfigGeneration != before.ConfigGeneration+1 || after.Channels != `["wecom"]` {
		t.Fatalf("updated Pod generation/channels = %d/%s", after.ConfigGeneration, after.Channels)
	}
	assertEncryptedChannelConfig(t, e, "pod-channels", "bot-new", "secret-old")
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-channels" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestPodChannelUpdateRejectsInvalidPayload(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-invalid-update")
	for _, body := range []string{`{"channels":[]}`, `{"channels":["telegram"]}`, `not-json`} {
		rr := e.do(http.MethodPut, "/api/v1/containers/pod-invalid-update/channels", body)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("invalid body %q status = %d", body, rr.Code)
		}
	}
	if rr := e.do(http.MethodPut, "/api/v1/containers/unknown/channels", `{"channels":["wechat"]}`); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown Pod update status = %d", rr.Code)
	}
}

func createWeChatPod(t *testing.T, e *testEnv, podID string) {
	t.Helper()
	createPodThroughAPI(t, e, fmt.Sprintf(`{"podId":%q,"channels":["wechat"]}`, podID))
}

func createWeComPod(t *testing.T, e *testEnv, podID string) {
	t.Helper()
	body := fmt.Sprintf(
		`{"podId":%q,"channels":["wecom"],"channelConfigs":{"wecom":{"botId":"bot","secret":"secret"}}}`,
		podID,
	)
	createPodThroughAPI(t, e, body)
}
