//go:build e2e

package test

// Cross-boundary acceptance E2E for TASK-012 (S-01/S-02/S-05/S-14/S-16/E-11).
//
// The test wires the real components end to end:
//   - Console: httptest server over the real api.Server handler + real SQLite.
//   - Skill: the shipped Python muad_skill_http helper, run as a subprocess.
//   - Guard: the shipped runtime-guard skill-trace modules, run under Node.
//   - Business platform: a local HTTP server recording the requests it receives.
//   - Admin alert: the real notify.Dispatcher + WeCom channel (host allow-list
//     preserved) pointed at a local WeCom-shaped server.
//
// Nothing in the trace/limit/notify path is stubbed. Only the user IM delivery
// inside the guard is injected (E-06 contract: delivery must not affect trace).

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/notify"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const skillTraceE2EWebhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=e2e-trace"

type skillTraceE2E struct {
	t          *testing.T
	env        *testEnv
	server     *httptest.Server
	podToken   string
	adminToken string
	repoRoot   string
	testdata   string
	spoolRoot  string
	business   *businessRecorder
}

type businessRecord struct {
	Method, Path, Cookie, ManualCSRF, SecretHeader, Body string
}

type businessRecorder struct {
	mu      sync.Mutex
	records []businessRecord
}

func (recorder *businessRecorder) add(record businessRecord) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.records = append(recorder.records, record)
}

func (recorder *businessRecorder) snapshot() []businessRecord {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]businessRecord(nil), recorder.records...)
}

type guardConfig struct {
	Mode        string   `json:"mode,omitempty"`
	BaseURL     string   `json:"baseURL"`
	PodToken    string   `json:"podToken"`
	ExecutionID string   `json:"executionId"`
	AgentID     string   `json:"agentId"`
	SessionKey  string   `json:"sessionKey"`
	RunID       string   `json:"runId"`
	SkillName   string   `json:"skillName"`
	Limit       int      `json:"limit"`
	SpoolRoot   string   `json:"spoolRoot"`
	Python      string   `json:"python"`
	Script      string   `json:"script"`
	Args        []string `json:"args"`
	Command     string   `json:"command,omitempty"`
}

type guardNotification struct {
	Channel string `json:"channel"`
	PeerID  string `json:"peerId"`
	Text    string `json:"text"`
}

type guardResult struct {
	Env           map[string]string   `json:"env"`
	Modes         map[string]int      `json:"modes"`
	ExitCode      int                 `json:"exitCode"`
	Stdout        string              `json:"stdout"`
	Stderr        string              `json:"stderr"`
	Notifications []guardNotification `json:"notifications"`
	Spool         string              `json:"spool"`
	SpoolExists   bool                `json:"spoolExists"`
}

type wecomRecorder struct {
	mu       sync.Mutex
	payloads []string
}

func (recorder *wecomRecorder) add(payload string) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.payloads = append(recorder.payloads, payload)
}

func (recorder *wecomRecorder) snapshot() []string {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]string(nil), recorder.payloads...)
}

func newSkillTraceE2E(t *testing.T) *skillTraceE2E {
	t.Helper()
	env := newTestEnv(t)
	t.Cleanup(env.srv.Close)
	server := httptest.NewServer(env.h)
	t.Cleanup(server.Close)
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	h := &skillTraceE2E{
		t: t, env: env, server: server, adminToken: env.token,
		repoRoot: repoRoot, spoolRoot: t.TempDir(),
		testdata: filepath.Join(repoRoot, "console/backend/test/testdata/skill_trace_e2e"),
		business: &businessRecorder{},
	}
	h.podToken = createPodWithToken(t, env, "pod-a")
	return h
}

func (h *skillTraceE2E) createExecution(executionID, agentID, skillName, scope string) {
	h.t.Helper()
	body := fmt.Sprintf(`{"executionId":%q,"agentId":%q,"skillName":%q,"skillScope":%q,"startedAt":%q}`,
		executionID, agentID, skillName, scope, time.Now().UTC().Format(time.RFC3339))
	response := h.internalPost("/internal/v1/skill-executions", h.podToken, body)
	if response.Code != http.StatusOK {
		h.t.Fatalf("create execution = %d: %s", response.Code, response.Body)
	}
}

func (h *skillTraceE2E) internalPost(path, token, body string) *httpResponse {
	request, err := http.NewRequest(http.MethodPost, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatalf("build internal request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	return h.doRequest(request)
}

func (h *skillTraceE2E) adminDo(method, path, body string) *httpResponse {
	request, err := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatalf("build admin request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+h.adminToken)
	request.Header.Set("Content-Type", "application/json")
	return h.doRequest(request)
}

func (h *skillTraceE2E) doRequest(request *http.Request) *httpResponse {
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatalf("HTTP %s %s: %v", request.Method, request.URL.Path, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		h.t.Fatalf("read response: %v", err)
	}
	return &httpResponse{Code: response.StatusCode, Body: body}
}

type httpResponse struct {
	Code int
	Body []byte
}

type apiEnvelope struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
}

func (response *httpResponse) data(t *testing.T, target any) {
	t.Helper()
	var envelope apiEnvelope
	if err := json.Unmarshal(response.Body, &envelope); err != nil {
		t.Fatalf("decode response: %v (%s)", err, response.Body)
	}
	if envelope.Code != 0 {
		t.Fatalf("API code = %d: %s", envelope.Code, response.Body)
	}
	if err := json.Unmarshal(envelope.Data, target); err != nil {
		t.Fatalf("decode data: %v", err)
	}
}

func (h *skillTraceE2E) businessServer() string {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h.business.add(businessRecord{
			Method: r.Method, Path: r.URL.Path,
			Cookie: r.Header.Get("Cookie"), ManualCSRF: r.Header.Get("X-Manual-Csrf"),
			SecretHeader: r.Header.Get("X-E2E-Secret-Header"), Body: string(body),
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	h.t.Cleanup(server.Close)
	return server.URL
}

func (h *skillTraceE2E) runGuard(config guardConfig) (guardResult, error) {
	config.BaseURL = firstNonEmpty(config.BaseURL, h.server.URL)
	config.PodToken = h.podToken
	config.SpoolRoot = firstNonEmpty(config.SpoolRoot, h.spoolRoot)
	config.Python = firstNonEmpty(config.Python, os.Getenv("MUAD_E2E_PYTHON"), "python3")
	encoded, err := json.Marshal(config)
	if err != nil {
		return guardResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(h.testdata, "guard_runner.mjs"))
	command.Dir = h.testdata
	command.Env = append(os.Environ(),
		"GUARD_SRC="+filepath.Join(h.repoRoot, "tools/muad-runtime-guard/src"),
		"E2E_CONFIG="+string(encoded),
		"PYTHONPATH="+filepath.Join(h.repoRoot, "tools/muad-skill-sdk"),
		"NO_PROXY=127.0.0.1,localhost", "no_proxy=127.0.0.1,localhost",
	)
	output, err := command.CombinedOutput()
	if err != nil {
		return guardResult{}, fmt.Errorf("guard runner: %w: %s", err, output)
	}
	var result guardResult
	if err := json.Unmarshal(output, &result); err != nil {
		return guardResult{}, fmt.Errorf("decode guard result: %w: %s", err, output)
	}
	return result, nil
}

func (h *skillTraceE2E) trace(executionID string) skillExecutionTraceView {
	h.t.Helper()
	response := h.adminDo(http.MethodGet, "/api/v1/skill-executions/"+executionID+"/trace", "")
	if response.Code != http.StatusOK {
		h.t.Fatalf("GET trace = %d: %s", response.Code, response.Body)
	}
	var trace skillExecutionTraceView
	response.data(h.t, &trace)
	return trace
}

func (h *skillTraceE2E) stats(query string) skillExecutionStatsView {
	h.t.Helper()
	response := h.adminDo(http.MethodGet, "/api/v1/skill-executions/stats?"+query, "")
	if response.Code != http.StatusOK {
		h.t.Fatalf("GET stats = %d: %s", response.Code, response.Body)
	}
	var stats skillExecutionStatsView
	response.data(h.t, &stats)
	return stats
}

func (h *skillTraceE2E) configureNotify() *wecomRecorder {
	h.t.Helper()
	recorder := &wecomRecorder{}
	wecom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		recorder.add(string(body))
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	h.t.Cleanup(wecom.Close)
	target, err := url.Parse(wecom.URL)
	if err != nil {
		h.t.Fatalf("parse wecom URL: %v", err)
	}
	h.env.srv.WithNotifyChannelFactory(func(webhook string) (notify.Channel, error) {
		return notify.NewWeComChannel(webhook, notify.WithHTTPClient(&http.Client{
			Transport: &webhookRewriteTransport{target: target, base: http.DefaultTransport},
		}))
	})
	response := h.adminDo(http.MethodPut, "/api/v1/settings/notify",
		fmt.Sprintf(`{"enabled":true,"webhook":%q}`, skillTraceE2EWebhook))
	if response.Code != http.StatusOK {
		h.t.Fatalf("PUT notify = %d: %s", response.Code, response.Body)
	}
	return recorder
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func e2eUUID(t *testing.T) string {
	t.Helper()
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		t.Fatalf("random uuid: %v", err)
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16])
}

func mustRun(t *testing.T, dir string, timeout time.Duration, name string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "NO_PROXY=127.0.0.1,localhost", "no_proxy=127.0.0.1,localhost")
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output.String())
	}
	return output.String()
}

func waitFor(t *testing.T, timeout time.Duration, description string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func (h *skillTraceE2E) traceBody(executionID string) string {
	h.t.Helper()
	response := h.adminDo(http.MethodGet, "/api/v1/skill-executions/"+executionID+"/trace", "")
	if response.Code != http.StatusOK {
		h.t.Fatalf("GET trace = %d: %s", response.Code, response.Body)
	}
	return string(response.Body)
}

func findStat(stats skillExecutionStatsView, skillName, humanUserID string) *skillExecutionStatView {
	for index := range stats.Items {
		item := &stats.Items[index]
		if item.SkillName == skillName && item.HumanUserID == humanUserID {
			return item
		}
	}
	return nil
}

// TestSkillTraceE2E_S01 covers the normal full chain: Python helper -> spool ->
// guard parse/upload -> internal API -> SQLite -> query API, including
// redaction of headers/body.
func TestSkillTraceE2E_S01(t *testing.T) {
	h := newSkillTraceE2E(t)
	business := h.businessServer()
	businessURL, _ := url.Parse(business)
	user := createTestHumanUser(t, h.env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	executionID := e2eUUID(t)
	h.createExecution(executionID, user.AgentID, "xdr-query", "public")

	result, err := h.runGuard(guardConfig{
		ExecutionID: executionID, AgentID: user.AgentID,
		SessionKey: "agent:alice:wecom:direct:wx-alice", RunID: "run-s01",
		SkillName: "xdr-query", Limit: 1000,
		Script: filepath.Join(h.testdata, "helper_skill.py"),
		Args:   []string{business, "3", "/api/v1/targets"}, Command: "python3 helper_skill.py",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.Stdout == "" {
		t.Fatalf("skill result = %+v", result)
	}
	if result.Env["MUAD_EXECUTION_ID"] != executionID ||
		result.Env["MUAD_TRACE_SPOOL"] != filepath.Join(h.spoolRoot, executionID+".jsonl") ||
		result.Env["MUAD_SKILL_REQUEST_LIMIT"] != "1000" {
		t.Fatalf("exec env = %+v", result.Env)
	}
	if result.Modes["spool"] != 0o600 || result.Modes["root"] != 0o700 || result.SpoolExists {
		t.Fatalf("spool modes/existence = %v exists=%v", result.Modes, result.SpoolExists)
	}

	trace := h.trace(executionID)
	if trace.Metrics == nil || trace.Metrics.RequestCount != 3 || trace.Metrics.ErrorCount != 0 ||
		trace.Metrics.DistinctHosts != 1 || trace.Metrics.Aborted {
		t.Fatalf("metrics = %+v", trace.Metrics)
	}
	if len(trace.Metrics.TopInterfaces) != 1 ||
		trace.Metrics.TopInterfaces[0].Host != businessURL.Host ||
		trace.Metrics.TopInterfaces[0].Path != "/api/v1/targets/{id}" ||
		trace.Metrics.TopInterfaces[0].Count != 3 {
		t.Fatalf("top interfaces = %+v", trace.Metrics.TopInterfaces)
	}
	if len(trace.Events) != 4 || trace.Events[0].Kind != "exec" ||
		trace.Events[1].Kind != "http" || trace.Events[3].Status != "ok" {
		t.Fatalf("events = %+v", trace.Events)
	}
	body := h.traceBody(executionID)
	for _, secret := range []string{"e2e-secret-header", "e2e-secret-body", "Cookie"} {
		if strings.Contains(body, secret) {
			t.Fatalf("trace leaked %q: %s", secret, body)
		}
	}
	records := h.business.snapshot()
	if len(records) != 3 || records[0].SecretHeader != "e2e-secret-header" ||
		!strings.Contains(records[0].Body, "e2e-secret-body") {
		t.Fatalf("business requests = %+v", records)
	}
}

// TestSkillTraceE2E_S02 covers the limit path: the N+1 request is never sent,
// the helper exits 86, the guard reports an abort and notifies the user, and
// Console stores the abort then fans out one admin alert over WeCom.
func TestSkillTraceE2E_S02(t *testing.T) {
	h := newSkillTraceE2E(t)
	wecom := h.configureNotify()
	business := h.businessServer()
	user := createTestHumanUser(t, h.env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	executionID := e2eUUID(t)
	h.createExecution(executionID, user.AgentID, "xdr-query", "public")

	result, err := h.runGuard(guardConfig{
		ExecutionID: executionID, AgentID: user.AgentID,
		SessionKey: "agent:alice:wecom:direct:wx-alice", RunID: "run-s02",
		SkillName: "xdr-query", Limit: 3,
		Script: filepath.Join(h.testdata, "helper_skill.py"),
		Args:   []string{business, "4", "/api/v1/targets"}, Command: "python3 helper_skill.py",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 86 {
		t.Fatalf("exit code = %d, want 86 (stderr=%s)", result.ExitCode, result.Stderr)
	}
	if len(h.business.snapshot()) != 3 {
		t.Fatalf("business received %d requests, want 3", len(h.business.snapshot()))
	}
	if len(result.Notifications) != 1 ||
		result.Notifications[0].Channel != "wecom" || result.Notifications[0].PeerID != "wx-alice" ||
		!strings.Contains(result.Notifications[0].Text, "xdr-query") {
		t.Fatalf("user notifications = %+v", result.Notifications)
	}

	trace := h.trace(executionID)
	if trace.Metrics == nil || !trace.Metrics.Aborted || trace.Metrics.AbortReason != "request_limit" ||
		trace.Metrics.RequestCount != 4 || trace.Metrics.AbortCount == nil ||
		*trace.Metrics.AbortCount != 4 ||
		!strings.HasPrefix(trace.Metrics.AbortInterface, "GET ") ||
		!strings.HasSuffix(trace.Metrics.AbortInterface, "/api/v1/targets/{id}") {
		t.Fatalf("aborted metrics = %+v", trace.Metrics)
	}
	if len(trace.Events) != 5 || trace.Events[0].Kind != "exec" || trace.Events[4].Kind != "abort" ||
		trace.Events[4].Status != "error" {
		t.Fatalf("aborted events = %+v", trace.Events)
	}
	waitFor(t, 5*time.Second, "admin WeCom alert", func() bool { return len(wecom.snapshot()) == 1 })
	alert := wecom.snapshot()[0]
	if !strings.Contains(alert, user.HumanUserID) || !strings.Contains(alert, "xdr-query") {
		t.Fatalf("admin alert payload = %s", alert)
	}
}

// TestSkillTraceE2E_S05 covers execution data -> stats SQL -> query API -> real
// Audit UI (vitest + jsdom hitting this live Console, then drilling down).
func TestSkillTraceE2E_S05(t *testing.T) {
	h := newSkillTraceE2E(t)
	business := h.businessServer()
	user := createTestHumanUser(t, h.env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	executionID := e2eUUID(t)
	h.createExecution(executionID, user.AgentID, "mss-report-skill", "public")
	result, err := h.runGuard(guardConfig{
		ExecutionID: executionID, AgentID: user.AgentID,
		SessionKey: "agent:alice:wecom:direct:wx-alice", RunID: "run-s05",
		SkillName: "mss-report-skill", Limit: 3,
		Script: filepath.Join(h.testdata, "helper_skill.py"),
		Args:   []string{business, "4", "/api/v1/targets"}, Command: "python3 helper_skill.py",
	})
	if err != nil || result.ExitCode != 86 {
		t.Fatalf("aborted run = %+v, %v", result, err)
	}

	stats := h.stats("window=7d&scope=public")
	row := findStat(stats, "mss-report-skill", user.HumanUserID)
	if row == nil || row.AbortedCount != 1 || row.FlaggedCount != 1 || row.MaxRequests != 4 ||
		len(row.TopInterfaces) == 0 || row.TopInterfaces[0].Path != "/api/v1/targets/{id}" {
		t.Fatalf("stats row = %+v (all=%+v)", row, stats.Items)
	}
	runFrontendE2E(t, h.repoRoot, h.server.URL, "mss-report-skill", executionID)
}

// TestSkillTraceE2E_S14 runs two users of one Pod concurrently and asserts
// per-execution trace separation, per-user alerts and per-user stats rows.
func TestSkillTraceE2E_S14(t *testing.T) {
	h := newSkillTraceE2E(t)
	wecom := h.configureNotify()
	business := h.businessServer()
	alice := createTestHumanUser(t, h.env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, h.env.store, "pod-a", "bob", repo.HumanUserStatusActive)
	users := []repo.HumanUser{alice, bob}
	executionIDs := []string{e2eUUID(t), e2eUUID(t)}
	for index, user := range users {
		h.createExecution(executionIDs[index], user.AgentID, "mss-report-skill", "public")
	}
	results := make([]guardResult, 2)
	errors := make([]error, 2)
	var wait sync.WaitGroup
	for index, user := range users {
		wait.Add(1)
		go func(index int, user repo.HumanUser) {
			defer wait.Done()
			results[index], errors[index] = h.runGuard(guardConfig{
				ExecutionID: executionIDs[index], AgentID: user.AgentID,
				SessionKey: fmt.Sprintf("agent:%s:wecom:direct:wx-%s", user.AgentID, user.AgentID),
				RunID:      fmt.Sprintf("run-s14-%d", index),
				SkillName:  "mss-report-skill", Limit: 2,
				Script: filepath.Join(h.testdata, "helper_skill.py"),
				Args:   []string{business, "3", "/api/v1/targets"},
			})
		}(index, user)
	}
	wait.Wait()
	for index := range users {
		if errors[index] != nil || results[index].ExitCode != 86 {
			t.Fatalf("user %d run = %+v, %v", index, results[index], errors[index])
		}
		if len(results[index].Notifications) != 1 ||
			results[index].Notifications[0].PeerID != "wx-"+users[index].AgentID {
			t.Fatalf("user %d notifications = %+v", index, results[index].Notifications)
		}
		trace := h.trace(executionIDs[index])
		if trace.Metrics == nil || !trace.Metrics.Aborted || trace.Metrics.AbortCount == nil ||
			*trace.Metrics.AbortCount != 3 {
			t.Fatalf("user %d metrics = %+v", index, trace.Metrics)
		}
		for _, event := range trace.Events {
			if !strings.HasPrefix(event.EventID, executionIDs[index]+":") {
				t.Fatalf("user %d trace mixed event %+v", index, event)
			}
		}
	}
	waitFor(t, 5*time.Second, "two admin alerts", func() bool { return len(wecom.snapshot()) == 2 })
	payloads := strings.Join(wecom.snapshot(), "\n")
	if !strings.Contains(payloads, alice.HumanUserID) || !strings.Contains(payloads, bob.HumanUserID) {
		t.Fatalf("per-user alerts = %s", payloads)
	}
	stats := h.stats("window=7d&scope=public")
	aliceRow := findStat(stats, "mss-report-skill", alice.HumanUserID)
	bobRow := findStat(stats, "mss-report-skill", bob.HumanUserID)
	if aliceRow == nil || bobRow == nil || aliceRow.AbortedCount != 1 || bobRow.AbortedCount != 1 {
		t.Fatalf("per-user stats = %+v", stats.Items)
	}
}

// TestSkillTraceE2E_S16 runs an unmigrated Skill (raw requests + manual
// headers + legacy state file). It must keep working, be exempt from limits,
// and produce only an exec event.
func TestSkillTraceE2E_S16(t *testing.T) {
	h := newSkillTraceE2E(t)
	business := h.businessServer()
	user := createTestHumanUser(t, h.env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	executionID := e2eUUID(t)
	h.createExecution(executionID, user.AgentID, "legacy-report", "private")
	stateFile := filepath.Join(t.TempDir(), "state.json")
	state := `{"platforms":{"mssw":{"cookies":"session=legacy-cookie",` +
		`"csrfToken":"legacy-csrf","storageState":"/tmp/legacy-storage.json"}}}`
	if err := os.WriteFile(stateFile, []byte(state), 0o600); err != nil {
		t.Fatalf("write legacy state: %v", err)
	}
	result, err := h.runGuard(guardConfig{
		ExecutionID: executionID, AgentID: user.AgentID,
		SessionKey: "agent:alice:wecom:direct:wx-alice", RunID: "run-s16",
		SkillName: "legacy-report", Limit: 1,
		Script: filepath.Join(h.testdata, "legacy_skill.py"),
		Args:   []string{stateFile, business, "3"}, Command: "python3 legacy_skill.py",
	})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("legacy run = %+v, %v", result, err)
	}
	if len(result.Notifications) != 0 {
		t.Fatalf("legacy skill triggered limit notification: %+v", result.Notifications)
	}
	records := h.business.snapshot()
	if len(records) != 3 || records[0].Cookie != "session=legacy-cookie" ||
		records[0].ManualCSRF != "legacy-csrf" {
		t.Fatalf("legacy requests = %+v", records)
	}
	trace := h.trace(executionID)
	if trace.Metrics == nil || trace.Metrics.RequestCount != 0 || trace.Metrics.Aborted {
		t.Fatalf("legacy metrics = %+v", trace.Metrics)
	}
	if len(trace.Events) != 1 || trace.Events[0].Kind != "exec" || trace.Events[0].Status != "ok" {
		t.Fatalf("legacy events = %+v", trace.Events)
	}
}

// TestSkillTraceE2E_E11 covers upgrade order and version mismatch: a new guard
// against an old Console retains the spool and succeeds after the Console
// upgrade; an old guard against the new Console degrades without crashing.
func TestSkillTraceE2E_E11(t *testing.T) {
	h := newSkillTraceE2E(t)
	business := h.businessServer()
	user := createTestHumanUser(t, h.env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	executionID := e2eUUID(t)
	h.createExecution(executionID, user.AgentID, "xdr-query", "public")

	oldConsole := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":40400,"message":"not found"}`))
	}))
	defer oldConsole.Close()
	config := guardConfig{
		ExecutionID: executionID, AgentID: user.AgentID,
		SessionKey: "agent:alice:wecom:direct:wx-alice", RunID: "run-e11",
		SkillName: "xdr-query", Limit: 1000, BaseURL: oldConsole.URL,
		Script: filepath.Join(h.testdata, "helper_skill.py"),
		Args:   []string{business, "1", "/api/v1/targets"}, Command: "python3 helper_skill.py",
	}
	result, err := h.runGuard(config)
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("old-console run = %+v, %v", result, err)
	}
	if !result.SpoolExists {
		t.Fatal("spool was not retained after the old Console rejected the upload")
	}
	config.BaseURL, config.Mode = h.server.URL, "upload"
	result, err = h.runGuard(config)
	if err != nil || result.SpoolExists {
		t.Fatalf("retry after Console upgrade = %+v, %v", result, err)
	}
	if trace := h.trace(executionID); trace.Metrics == nil || trace.Metrics.RequestCount != 1 {
		t.Fatalf("trace after upgrade = %+v", trace.Metrics)
	}

	oldGuardExecution := e2eUUID(t)
	h.createExecution(oldGuardExecution, user.AgentID, "xdr-query", "public")
	trace := h.trace(oldGuardExecution)
	if trace.Metrics != nil || len(trace.Events) != 0 {
		t.Fatalf("old-guard execution trace = %+v", trace)
	}
	stats := h.stats("window=7d&scope=public")
	if row := findStat(stats, "xdr-query", user.HumanUserID); row == nil || row.MaxRequests != 1 {
		t.Fatalf("degraded stats = %+v", stats.Items)
	}
}

// TestSkillTraceE2E_RULE13 re-runs the compatibility suites that pin the old
// behavior: raw requests bypass, legacy state files and the guard trace parser.
func TestSkillTraceE2E_RULE13(t *testing.T) {
	h := newSkillTraceE2E(t)
	mustRun(t, h.repoRoot, 180*time.Second, "python3", "-m", "pytest", "-q", "tools/muad-skill-sdk/test")
	mustRun(t, h.repoRoot, 120*time.Second, "node", "--test",
		"--test-name-pattern=SkillTrace", "tools/muad-runtime-guard/test/skill-trace.test.mjs")
}

func runFrontendE2E(t *testing.T, repoRoot, apiBase, skillName, executionID string) {
	t.Helper()
	frontendDir := filepath.Join(repoRoot, "console/frontend")
	vitest := filepath.Join(frontendDir, "node_modules/.bin/vitest")
	if _, err := os.Stat(vitest); err != nil {
		t.Fatalf("frontend dependencies missing (run `npm ci` in console/frontend): %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, vitest, "run", "--config", "vitest.e2e.config.ts")
	command.Dir = frontendDir
	command.Env = append(os.Environ(),
		"MUAD_E2E_API_BASE="+apiBase,
		"MUAD_E2E_SKILL="+skillName,
		"MUAD_E2E_EXECUTION_ID="+executionID,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("frontend E2E: %v\n%s", err, output)
	}
}
