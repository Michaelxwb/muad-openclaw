package test

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// SessionCancel* [integration] 真实边界：httptest → 真实 Store → fake Driver。
// 覆盖 E-01 空预览、E-03 能力门禁、E-04 归属/longtask 拒绝、S-05 审计脱敏与
// 41009/41010 稳定错误映射。

const (
	sessionCancelExternalID = "Alice-External"
	sessionCancelKey        = "agent:alice:wecom:direct:alice"
)

func enableSessionCancel(e *testEnv, podID string) {
	e.srv.CancelCapabilities().Update(podID, gateway.CancelCapability{
		SessionCancel: gateway.SessionCancelCapability{Available: true, Version: 1},
	})
}

func seedSessionCancelIdentity(
	t *testing.T, e *testEnv, humanUserID, externalID string,
) repo.UserIdentity {
	t.Helper()
	identity, err := e.store.CreateIdentity(repo.UserIdentity{
		HumanUserID: humanUserID, Channel: "wecom", OpenClawChannel: "wecom",
		AccountID: "default", ExternalID: externalID, ExternalIDType: "userid",
		PeerKind: "direct", Status: repo.IdentityStatusActive,
	})
	if err != nil {
		t.Fatalf("seed session cancel identity %s: %v", externalID, err)
	}
	return identity
}

func sessionCancelPath(humanUserID, identityID, action string) string {
	return "/api/v1/human-users/" + humanUserID + "/identities/" + identityID + "/session/" + action
}

func sessionExecCalls(e *testEnv) [][]string {
	e.drv.mu.Lock()
	defer e.drv.mu.Unlock()
	var calls [][]string
	for _, call := range e.drv.execCalls {
		if strings.Contains(strings.Join(call.cmd, " "), "muad.session.") {
			calls = append(calls, call.cmd)
		}
	}
	return calls
}

func sessionInjectCalls(e *testEnv) [][]string {
	e.drv.mu.Lock()
	defer e.drv.mu.Unlock()
	var calls [][]string
	for _, call := range e.drv.execCalls {
		if strings.Contains(strings.Join(call.cmd, " "), "chat.inject") {
			calls = append(calls, call.cmd)
		}
	}
	return calls
}

type sessionCancelEnvelope struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		SessionKey string `json:"sessionKey"`
		AgentID    string `json:"agentId"`
		ActiveRun  struct {
			Active bool `json:"active"`
		} `json:"activeRun"`
		Processes []json.RawMessage `json:"processes"`
		Skipped   struct {
			EnvMismatch int `json:"envMismatch"`
		} `json:"skipped"`
		Aborted   bool  `json:"aborted"`
		Drained   bool  `json:"drained"`
		Confirmed bool  `json:"confirmed"`
		Killed    int   `json:"killed"`
		Remaining []int `json:"remaining"`
	} `json:"data"`
}

func decodeSessionCancelEnvelope(t *testing.T, body []byte) sessionCancelEnvelope {
	t.Helper()
	var envelope sessionCancelEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode session cancel envelope: %v body=%s", err, body)
	}
	return envelope
}

// E-01: 会话没有活跃 run 也没有匹配进程时，preview 返回 processes=[] 且 code=0；
// session key 完全由 identity 推导（channel 兜底、PeerKind 兜底、externalID 小写）。
func TestSessionCancelPreviewEmptyProcesses(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	identity := seedSessionCancelIdentity(t, e, user.HumanUserID, sessionCancelExternalID)
	enableSessionCancel(e, pod.PodID)
	e.drv.sessionPreviewOut = `{"ok":true,"sessionKey":"` + sessionCancelKey + `",` +
		`"agentId":"alice","activeRun":{"active":false},"processes":[],` +
		`"skipped":{"notOwner":0,"envMismatch":2,"permissionDenied":0}}`

	rr := e.do(http.MethodPost, sessionCancelPath(user.HumanUserID, identity.IdentityID, "preview"), "")
	if rr.Code != http.StatusOK {
		t.Fatalf("preview status = %d, want 200: %s", rr.Code, rr.Body.String())
	}
	envelope := decodeSessionCancelEnvelope(t, rr.Body.Bytes())
	if envelope.Code != 0 || envelope.Data.SessionKey != sessionCancelKey ||
		envelope.Data.AgentID != "alice" || envelope.Data.ActiveRun.Active {
		t.Fatalf("preview envelope = %+v", envelope)
	}
	if envelope.Data.Processes == nil || len(envelope.Data.Processes) != 0 {
		t.Fatalf("empty preview processes = %#v, want []", envelope.Data.Processes)
	}
	if !strings.Contains(rr.Body.String(), `"processes":[]`) {
		t.Fatalf("empty preview must serialize processes as []: %s", rr.Body.String())
	}
	if envelope.Data.Skipped.EnvMismatch != 2 {
		t.Fatalf("skipped counts lost: %+v", envelope.Data)
	}

	calls := sessionExecCalls(e)
	if len(calls) != 1 || !strings.Contains(strings.Join(calls[0], " "), "muad.session.preview") {
		t.Fatalf("expected one preview RPC, got %#v", calls)
	}
	var params struct {
		SessionKey  string `json:"sessionKey"`
		RequestedBy string `json:"requestedBy"`
	}
	if err := json.Unmarshal([]byte(argValue(calls[0], "--params")), &params); err != nil {
		t.Fatalf("preview params must be JSON: %v", err)
	}
	if params.SessionKey != sessionCancelKey || params.RequestedBy != "root" {
		t.Fatalf("preview params = %+v, want derived key and login actor", params)
	}
}

// E-03: 能力未知/过期/不可用一律 41007，且不产生任何运行调用。
func TestSessionCancelCapabilityGate(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	identity := seedSessionCancelIdentity(t, e, user.HumanUserID, sessionCancelExternalID)
	previewPath := sessionCancelPath(user.HumanUserID, identity.IdentityID, "preview")
	cancelPath := sessionCancelPath(user.HumanUserID, identity.IdentityID, "cancel")
	expectedBody := `{"expected":[{"pid":4028,"fingerprint":"fp-1"}]}`

	// 未知能力。
	unknown := e.do(http.MethodPost, previewPath, "")
	if unknown.Code != http.StatusConflict || decodeSessionCancelEnvelope(t, unknown.Body.Bytes()).Code != errcode.SessionCancelUnsupported {
		t.Fatalf("unknown capability preview = status %d body %s", unknown.Code, unknown.Body.String())
	}

	// 过期能力：TTL 到期的快照与未知等价。
	expiring := gateway.NewCancelCapabilityCache(time.Nanosecond)
	expiring.Update(pod.PodID, gateway.CancelCapability{
		SessionCancel: gateway.SessionCancelCapability{Available: true, Version: 1},
	})
	e.srv.WithCancelCapabilities(expiring)
	time.Sleep(2 * time.Millisecond)
	expired := e.do(http.MethodPost, previewPath, "")
	if expired.Code != http.StatusConflict || decodeSessionCancelEnvelope(t, expired.Body.Bytes()).Code != errcode.SessionCancelUnsupported {
		t.Fatalf("expired capability preview = status %d body %s", expired.Code, expired.Body.String())
	}

	// 已知但不可用。
	unavailable := gateway.NewCancelCapabilityCache(time.Minute)
	unavailable.Update(pod.PodID, gateway.CancelCapability{
		SessionCancel: gateway.SessionCancelCapability{Available: false, Version: 1},
	})
	e.srv.WithCancelCapabilities(unavailable)
	rejected := e.do(http.MethodPost, cancelPath, expectedBody)
	if rejected.Code != http.StatusConflict || decodeSessionCancelEnvelope(t, rejected.Body.Bytes()).Code != errcode.SessionCancelUnsupported {
		t.Fatalf("unavailable capability cancel = status %d body %s", rejected.Code, rejected.Body.String())
	}
	if calls := sessionExecCalls(e); len(calls) != 0 {
		t.Fatalf("capability-gated requests must not call the runtime: %#v", calls)
	}

	// 能力拒绝也必须留痕：稳定错误码进审计，不含任何进程或命令内容。
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{Action: "session.cancel"})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("capability audit entries = %d/%d err=%v", len(entries), total, err)
	}
	if !strings.Contains(entries[0].Payload, `"errorCode":"41007"`) {
		t.Fatalf("capability audit must record 41007: %s", entries[0].Payload)
	}
	if strings.Contains(entries[0].Payload, "cmdline") || strings.Contains(entries[0].Payload, "environ") {
		t.Fatalf("capability audit leaked process diagnostics: %s", entries[0].Payload)
	}
}

// E-04: identity 不属于路径用户、跨 Pod、longtask 会话或用户不在运行 Pod 时拒绝，
// 且不发起任何 RPC；longtask 是客户端错误（400），归属错误是 404。
func TestSessionCancelRejectsForeignIdentityAndLongTask(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, e.store, pod.PodID, "bob", repo.HumanUserStatusActive)
	bobIdentity := seedSessionCancelIdentity(t, e, bob.HumanUserID, "bob-external")
	enableSessionCancel(e, pod.PodID)

	// identity 属于同 Pod 的另一个用户：404 41008。
	foreign := e.do(http.MethodPost, sessionCancelPath(alice.HumanUserID, bobIdentity.IdentityID, "preview"), "")
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("foreign identity status = %d, want 404", foreign.Code)
	}
	if envelope := decodeSessionCancelEnvelope(t, foreign.Body.Bytes()); envelope.Code != errcode.NotFoundSession {
		t.Fatalf("foreign identity code = %d, want %d", envelope.Code, errcode.NotFoundSession)
	}

	// identity 属于另一个 Pod 的用户：同样拒绝。
	podB := createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	bobB := createTestHumanUser(t, e.store, podB.PodID, "bob2", repo.HumanUserStatusActive)
	crossPodIdentity := seedSessionCancelIdentity(t, e, bobB.HumanUserID, "bob2-external")
	crossPod := e.do(http.MethodPost, sessionCancelPath(alice.HumanUserID, crossPodIdentity.IdentityID, "preview"), "")
	if crossPod.Code != http.StatusNotFound {
		t.Fatalf("cross-Pod identity status = %d, want 404", crossPod.Code)
	}
	if envelope := decodeSessionCancelEnvelope(t, crossPod.Body.Bytes()); envelope.Code != errcode.NotFoundSession {
		t.Fatalf("cross-Pod identity code = %d, want %d", envelope.Code, errcode.NotFoundSession)
	}

	// 推导 key 含 :longtask:：400，不进入 RPC。
	longTaskIdentity := seedSessionCancelIdentity(t, e, alice.HumanUserID, "room:longtask:peer")
	longTask := e.do(http.MethodPost, sessionCancelPath(alice.HumanUserID, longTaskIdentity.IdentityID, "cancel"),
		`{"expected":[{"pid":4028,"fingerprint":"fp-1"}]}`)
	if longTask.Code != http.StatusBadRequest {
		t.Fatalf("longtask identity status = %d, want 400", longTask.Code)
	}
	if envelope := decodeSessionCancelEnvelope(t, longTask.Body.Bytes()); envelope.Code != errcode.InvalidHumanUserRequest {
		t.Fatalf("longtask identity code = %d, want %d", envelope.Code, errcode.InvalidHumanUserRequest)
	}

	// 用户所在 Pod 不在运行：404，而不是误报能力不可用。
	normalIdentity := seedSessionCancelIdentity(t, e, alice.HumanUserID, "alice-external")
	if err := e.store.UpdatePodState(pod.PodID, repo.PodStateStopped); err != nil {
		t.Fatalf("stop Pod: %v", err)
	}
	stopped := e.do(http.MethodPost, sessionCancelPath(alice.HumanUserID, normalIdentity.IdentityID, "preview"), "")
	if stopped.Code != http.StatusNotFound {
		t.Fatalf("stopped Pod status = %d, want 404", stopped.Code)
	}
	if envelope := decodeSessionCancelEnvelope(t, stopped.Body.Bytes()); envelope.Code != errcode.NotFoundSession {
		t.Fatalf("stopped Pod code = %d, want %d", envelope.Code, errcode.NotFoundSession)
	}

	if calls := sessionExecCalls(e); len(calls) != 0 {
		t.Fatalf("rejected targets must not call the runtime: %#v", calls)
	}
}

// S-05: cancel 成功写 session.cancel 审计（目标字段 + 结果计数 + 稳定错误码），
// 不写 cmdline/environ/凭证；41009 与 41010 也走稳定映射和脱敏诊断。
func TestSessionCancelWritesRedactedAudit(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	identity := seedSessionCancelIdentity(t, e, user.HumanUserID, sessionCancelExternalID)
	enableSessionCancel(e, pod.PodID)
	cancelPath := sessionCancelPath(user.HumanUserID, identity.IdentityID, "cancel")
	requestBody := `{"expected":[{"pid":4028,"fingerprint":"fp-a"},{"pid":4029,"fingerprint":"fp-b"}]}`

	e.drv.sessionCancelOut = `{"ok":true,"aborted":true,"drained":true,"confirmed":false,` +
		`"killed":2,"remaining":[4030],"processes":[` +
		`{"pid":4028,"outcome":"terminated","reason":""},` +
		`{"pid":4029,"outcome":"terminated","reason":""}]}`
	rr := e.do(http.MethodPost, cancelPath, requestBody)
	if rr.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, want 200: %s", rr.Code, rr.Body.String())
	}
	envelope := decodeSessionCancelEnvelope(t, rr.Body.Bytes())
	if envelope.Code != 0 || !envelope.Data.Aborted || !envelope.Data.Drained ||
		envelope.Data.Confirmed || envelope.Data.Killed != 2 || len(envelope.Data.Remaining) != 1 {
		t.Fatalf("cancel envelope = %+v", envelope)
	}

	calls := sessionExecCalls(e)
	if len(calls) != 1 || !strings.Contains(strings.Join(calls[0], " "), "muad.session.cancel") {
		t.Fatalf("expected one cancel RPC, got %#v", calls)
	}
	var params struct {
		SessionKey  string `json:"sessionKey"`
		RequestedBy string `json:"requestedBy"`
		Expected    []struct {
			PID         int    `json:"pid"`
			Fingerprint string `json:"fingerprint"`
		} `json:"expected"`
	}
	if err := json.Unmarshal([]byte(argValue(calls[0], "--params")), &params); err != nil {
		t.Fatalf("cancel params must be JSON: %v", err)
	}
	if params.SessionKey != sessionCancelKey || params.RequestedBy != "root" || len(params.Expected) != 2 ||
		params.Expected[0].PID != 4028 || params.Expected[0].Fingerprint != "fp-a" {
		t.Fatalf("cancel params = %+v", params)
	}

	injectCalls := sessionInjectCalls(e)
	if len(injectCalls) != 1 {
		t.Fatalf("expected one chat.inject note, got %#v", injectCalls)
	}
	var note struct {
		SessionKey string `json:"sessionKey"`
		Message    string `json:"message"`
		Label      string `json:"label"`
	}
	if err := json.Unmarshal([]byte(argValue(injectCalls[0], "--params")), &note); err != nil {
		t.Fatalf("inject params must be JSON: %v", err)
	}
	if note.SessionKey != sessionCancelKey || note.Label != "muad.session-cancel" ||
		!strings.Contains(note.Message, "管理员已从控制台终止") ||
		!strings.Contains(note.Message, "不是模型执行失败") {
		t.Fatalf("inject note = %+v", note)
	}

	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{Action: "session.cancel"})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("success audit entries = %d/%d err=%v", len(entries), total, err)
	}
	entry := entries[0]
	if entry.Actor != "root" || entry.Target != identity.IdentityID {
		t.Fatalf("audit actor/target = %q/%q", entry.Actor, entry.Target)
	}
	var metadata struct {
		PodID       string `json:"podId"`
		HumanUserID string `json:"humanUserId"`
		AgentID     string `json:"agentId"`
		IdentityID  string `json:"identityId"`
		SessionKey  string `json:"sessionKey"`
		Aborted     bool   `json:"aborted"`
		Drained     bool   `json:"drained"`
		Killed      int    `json:"killed"`
		Remaining   int    `json:"remaining"`
		ErrorCode   string `json:"errorCode"`
	}
	if err := json.Unmarshal([]byte(entry.Payload), &metadata); err != nil {
		t.Fatalf("audit metadata: %v payload=%s", err, entry.Payload)
	}
	if metadata.PodID != pod.PodID || metadata.HumanUserID != user.HumanUserID ||
		metadata.AgentID != "alice" || metadata.IdentityID != identity.IdentityID ||
		metadata.SessionKey != sessionCancelKey || !metadata.Aborted || !metadata.Drained ||
		metadata.Killed != 2 || metadata.Remaining != 1 || metadata.ErrorCode != "" {
		t.Fatalf("audit metadata = %+v", metadata)
	}
	for _, forbidden := range []string{"cmdline", "environ", "fp-a", "fp-b", "super-secret-xyz", "sk-"} {
		if strings.Contains(entry.Payload, forbidden) {
			t.Fatalf("audit payload must not contain %q: %s", forbidden, entry.Payload)
		}
	}

	// 41009: 没有 abort、也没有杀掉进程，全部 expected 指纹失效，提示重新预览。
	e.drv.sessionCancelOut = `{"ok":true,"aborted":false,"drained":false,"confirmed":false,` +
		`"killed":0,"remaining":[4028],"processes":[` +
		`{"pid":4028,"outcome":"skipped","reason":"fingerprint_mismatch"}]}`
	stale := e.do(http.MethodPost, cancelPath, requestBody)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale preview status = %d, want 409", stale.Code)
	}
	if got := decodeSessionCancelEnvelope(t, stale.Body.Bytes()).Code; got != errcode.ConflictSessionPreviewStale {
		t.Fatalf("stale preview code = %d, want %d", got, errcode.ConflictSessionPreviewStale)
	}

	// 41010: RPC 失败不伪报成功，诊断经 RedactDiagnostic 脱敏。
	e.drv.sessionCancelErr = errors.New("exec failed: token=super-secret-xyz")
	failed := e.do(http.MethodPost, cancelPath, requestBody)
	if failed.Code != http.StatusBadGateway {
		t.Fatalf("failed cancel status = %d, want 502", failed.Code)
	}
	if got := decodeSessionCancelEnvelope(t, failed.Body.Bytes()).Code; got != errcode.SessionCancelFailed {
		t.Fatalf("failed cancel code = %d, want %d", got, errcode.SessionCancelFailed)
	}
	if strings.Contains(failed.Body.String(), "super-secret-xyz") ||
		!strings.Contains(failed.Body.String(), "token=[redacted]") {
		t.Fatalf("failed cancel diagnostic must be redacted: %s", failed.Body.String())
	}

	entries, total, err = e.store.QueryAuditFiltered(repo.AuditFilter{Action: "session.cancel"})
	if err != nil || total != 3 || len(entries) != 3 {
		t.Fatalf("audit entries after failures = %d/%d err=%v", len(entries), total, err)
	}
	codes := map[string]bool{}
	for _, entry := range entries {
		var metadata struct {
			ErrorCode string `json:"errorCode"`
		}
		if err := json.Unmarshal([]byte(entry.Payload), &metadata); err != nil {
			t.Fatalf("audit metadata: %v", err)
		}
		codes[metadata.ErrorCode] = true
		if strings.Contains(entry.Payload, "super-secret-xyz") {
			t.Fatalf("audit leaked a credential: %s", entry.Payload)
		}
	}
	for _, want := range []string{"", "41009", "41010"} {
		if !codes[want] {
			t.Fatalf("missing audit errorCode %q in %v", want, codes)
		}
	}
}

// cancel 请求体每项指纹必须有效；空数组合法（只 abort run，不杀进程）。
func TestSessionCancelRejectsInvalidExpectedBody(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	identity := seedSessionCancelIdentity(t, e, user.HumanUserID, sessionCancelExternalID)
	enableSessionCancel(e, pod.PodID)
	cancelPath := sessionCancelPath(user.HumanUserID, identity.IdentityID, "cancel")

	for _, body := range []string{
		``,
		`{}`,
		`{"expected":[{"pid":0,"fingerprint":"fp"}]}`,
		`{"expected":[{"pid":4028,"fingerprint":""}]}`,
		`{"expected":[{"pid":4028,"fingerprint":"fp"}],"podId":"forged"}`,
		`not-json`,
	} {
		rr := e.do(http.MethodPost, cancelPath, body)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("invalid body %q status = %d, want 400", body, rr.Code)
		}
		if envelope := decodeSessionCancelEnvelope(t, rr.Body.Bytes()); envelope.Code != errcode.InvalidRequestBody {
			t.Fatalf("invalid body %q code = %d, want %d", body, envelope.Code, errcode.InvalidRequestBody)
		}
	}
	if calls := sessionExecCalls(e); len(calls) != 0 {
		t.Fatalf("invalid cancel bodies must not call the runtime: %#v", calls)
	}
}

// abort 已生效时进程可能随 abort 退出（sweeper 看到 not_found），仍是成功终止，
// 不能返回 41009 让管理员误以为需要重新预览。
func TestSessionCancelAbortedWithGoneProcessesReturnsSuccess(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	identity := seedSessionCancelIdentity(t, e, user.HumanUserID, sessionCancelExternalID)
	enableSessionCancel(e, pod.PodID)
	cancelPath := sessionCancelPath(user.HumanUserID, identity.IdentityID, "cancel")
	e.drv.sessionCancelOut = `{"ok":true,"aborted":true,"drained":true,"confirmed":true,` +
		`"killed":0,"remaining":[],"processes":[{"pid":4028,"outcome":"skipped","reason":"not_found"}]}`

	rr := e.do(http.MethodPost, cancelPath, `{"expected":[{"pid":4028,"fingerprint":"fp-1"}]}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("aborted-with-gone-processes status = %d, want 200: %s", rr.Code, rr.Body.String())
	}
	envelope := decodeSessionCancelEnvelope(t, rr.Body.Bytes())
	if envelope.Code != 0 || !envelope.Data.Aborted || !envelope.Data.Confirmed {
		t.Fatalf("aborted-with-gone-processes envelope = %+v", envelope)
	}
	if calls := sessionInjectCalls(e); len(calls) != 1 {
		t.Fatalf("expected cancel note injection, got %#v", calls)
	}
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{Action: "session.cancel"})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("audit entries = %d/%d err=%v", len(entries), total, err)
	}
	if strings.Contains(entries[0].Payload, "41009") {
		t.Fatalf("successful abort must not audit 41009: %s", entries[0].Payload)
	}
}

// B-07: 空 expected 合法——只 abort run，不杀进程；请求必须到达 RPC。
func TestSessionCancelAcceptsEmptyExpected(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	identity := seedSessionCancelIdentity(t, e, user.HumanUserID, sessionCancelExternalID)
	enableSessionCancel(e, pod.PodID)
	cancelPath := sessionCancelPath(user.HumanUserID, identity.IdentityID, "cancel")
	e.drv.sessionCancelOut = `{"ok":true,"aborted":true,"drained":true,"confirmed":true,"killed":0,"remaining":[],"processes":[]}`

	rr := e.do(http.MethodPost, cancelPath, `{"expected":[]}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("empty expected status = %d, want 200: %s", rr.Code, rr.Body.String())
	}
	envelope := decodeSessionCancelEnvelope(t, rr.Body.Bytes())
	if envelope.Code != 0 || !envelope.Data.Aborted || !envelope.Data.Drained || envelope.Data.Killed != 0 {
		t.Fatalf("empty expected envelope = %+v", envelope)
	}
	calls := sessionExecCalls(e)
	if len(calls) != 1 || !strings.Contains(strings.Join(calls[0], " "), `"expected":[]`) {
		t.Fatalf("empty expected must reach cancel RPC, calls = %#v", calls)
	}
}
