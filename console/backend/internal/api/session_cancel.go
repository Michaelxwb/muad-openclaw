package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// 会话任务终止 Console API：session key 只由路径中的 identity 推导（RULE-07），
// 归属与能力校验通过后再调用 gateway 适配器；handler 不写 SQL、不拼 Shell。

const (
	sessionPreviewRequestTimeout = 10 * time.Second
	sessionCancelRequestTimeout  = 20 * time.Second
)

var (
	errSessionKeyInvalid   = errors.New("session key cannot be derived from identity")
	errSessionKeyForbidden = errors.New("session key targets a long task")
)

type sessionCancelTarget struct {
	podID      string
	user       repo.HumanUser
	identity   repo.UserIdentity
	sessionKey string
}

type sessionCancelRequest struct {
	Expected []gateway.SessionCancelExpected `json:"expected"`
}

// handlePreviewSessionCancel 实现 API-01：只读预览，空 body。
func (s *Server) handlePreviewSessionCancel(w http.ResponseWriter, r *http.Request) {
	target, ok := s.sessionCancelTargetForRequest(w, r)
	if !ok {
		return
	}
	if !s.sessionCancelCapability(w, r, target) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sessionPreviewRequestTimeout)
	defer cancel()
	result, err := gateway.PreviewSessionCancel(
		ctx, s.drv, target.podID, target.sessionKey, actorFrom(r.Context()))
	if err != nil {
		writeSessionCancelError(w, r, err)
		return
	}
	if result.Processes == nil {
		result.Processes = []gateway.SessionProcess{}
	}
	writeJSON(w, http.StatusOK, result)
}

// handleCancelSession 实现 API-02：expected 必须非空，只处理指纹仍匹配的进程。
func (s *Server) handleCancelSession(w http.ResponseWriter, r *http.Request) {
	target, ok := s.sessionCancelTargetForRequest(w, r)
	if !ok {
		return
	}
	var request sessionCancelRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	if !validSessionCancelExpected(request.Expected) {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	if !s.sessionCancelCapability(w, r, target) {
		s.auditSessionCancel(r, target, gateway.SessionCancelResult{}, errcode.SessionCancelUnsupported)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sessionCancelRequestTimeout)
	defer cancel()
	result, err := gateway.CancelSessionCancel(
		ctx, s.drv, target.podID, target.sessionKey, actorFrom(r.Context()), request.Expected)
	if err != nil {
		s.auditSessionCancel(r, target, gateway.SessionCancelResult{}, sessionCancelErrorCode(err))
		writeSessionCancelError(w, r, err)
		return
	}
	if sessionCancelAllSkipped(result) {
		s.auditSessionCancel(r, target, result, errcode.ConflictSessionPreviewStale)
		writeErr(w, r, errcode.ConflictSessionPreviewStale)
		return
	}
	if result.Remaining == nil {
		result.Remaining = []int{}
	}
	if result.Processes == nil {
		result.Processes = []gateway.SessionCancelProcess{}
	}
	s.auditSessionCancel(r, target, result, 0)
	// 给会话追加一条权威注记：下一轮模型据此知道是管理员终止，而不是把被杀的
	// process session 误判为模型执行失败。注记失败不影响已完成的终止结果。
	if result.Aborted || result.Killed > 0 {
		noteCtx, noteCancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		err := gateway.InjectSessionNote(noteCtx, s.drv, target.podID, target.sessionKey, sessionCancelNote(result))
		noteCancel()
		if err != nil {
			log.Printf("session_cancel_note_failed pod=%s error=%s",
				target.podID, auditlog.RedactDiagnostic(err.Error()))
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// sessionCancelNote 是注入会话的 assistant 注记：只陈述控制面事实，不把终止
// 归因给模型；同时明确禁止未经用户要求自动重跑。
func sessionCancelNote(result gateway.SessionCancelResult) string {
	var b strings.Builder
	b.WriteString("【系统通知】管理员已从控制台终止本会话上一轮任务。")
	if result.Aborted {
		b.WriteString("本轮 run 已中止。")
	}
	if result.Killed > 0 {
		fmt.Fprintf(&b, "已清理 %d 个后台进程。", result.Killed)
	}
	if len(result.Remaining) > 0 {
		fmt.Fprintf(&b, "仍有 %d 个进程未确认退出。", len(result.Remaining))
	}
	b.WriteString("上一轮的用户指令已作废：本轮不要执行、补跑、续跑或与新消息合并执行该任务；")
	b.WriteString("除非用户在本轮消息中明确要求重跑。这不是模型执行失败。")
	return b.String()
}

// sessionCancelTargetForRequest 校验 identity 归属、用户运行 Pod 与推导 key；
// 失败一律不发起 RPC。
func (s *Server) sessionCancelTargetForRequest(
	w http.ResponseWriter, r *http.Request,
) (sessionCancelTarget, bool) {
	humanUserID := strings.TrimSpace(r.PathValue("humanUserId"))
	identity, ok := s.sessionCancelIdentity(w, r, humanUserID)
	if !ok {
		return sessionCancelTarget{}, false
	}
	user, pod, ok := s.sessionCancelUserPod(w, r, humanUserID)
	if !ok {
		return sessionCancelTarget{}, false
	}
	sessionKey, ok := sessionCancelKeyForTarget(w, r, user, identity)
	if !ok {
		return sessionCancelTarget{}, false
	}
	return sessionCancelTarget{
		podID: pod.PodID, user: user, identity: identity, sessionKey: sessionKey,
	}, true
}

// sessionCancelIdentity 只接受路径用户自己的 identity（跨用户/跨 Pod 一律不暴露）。
func (s *Server) sessionCancelIdentity(
	w http.ResponseWriter, r *http.Request, humanUserID string,
) (repo.UserIdentity, bool) {
	identityID := strings.TrimSpace(r.PathValue("identityId"))
	if humanUserID == "" || identityID == "" {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.UserIdentity{}, false
	}
	identity, err := s.store.GetIdentity(identityID)
	if errors.Is(err, repo.ErrNotFound) {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.UserIdentity{}, false
	}
	if err != nil {
		writeRuntimeFailure(w, r, err, errcode.InternalError)
		return repo.UserIdentity{}, false
	}
	if identity.HumanUserID != humanUserID {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.UserIdentity{}, false
	}
	return identity, true
}

// sessionCancelUserPod 要求用户已绑定且其 Pod 处于运行态；否则按不存在处理。
func (s *Server) sessionCancelUserPod(
	w http.ResponseWriter, r *http.Request, humanUserID string,
) (repo.HumanUser, repo.Pod, bool) {
	user, err := s.store.GetHumanUser(humanUserID)
	if errors.Is(err, repo.ErrNotFound) {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	if err != nil {
		writeRuntimeFailure(w, r, err, errcode.InternalError)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	if user.PodID == "" {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	pod, err := s.store.GetPod(user.PodID)
	if errors.Is(err, repo.ErrNotFound) {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	if err != nil {
		writeRuntimeFailure(w, r, err, errcode.InternalError)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	if pod.State != repo.PodStateRunning {
		writeErr(w, r, errcode.NotFoundSession)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	return user, pod, true
}

func sessionCancelKeyForTarget(
	w http.ResponseWriter, r *http.Request, user repo.HumanUser, identity repo.UserIdentity,
) (string, bool) {
	sessionKey, err := deriveSessionKey(user, identity)
	if err == nil {
		return sessionKey, true
	}
	if errors.Is(err, errSessionKeyForbidden) {
		writeErr(w, r, errcode.InvalidHumanUserRequest)
	} else {
		writeErr(w, r, errcode.NotFoundSession)
	}
	return "", false
}

// deriveSessionKey 按 OpenClaw 会话 key 形状从 identity 推导；不接受前端输入。
func deriveSessionKey(user repo.HumanUser, identity repo.UserIdentity) (string, error) {
	agentID := strings.TrimSpace(user.AgentID)
	channel := strings.TrimSpace(identity.OpenClawChannel)
	if channel == "" {
		channel = strings.TrimSpace(identity.Channel)
	}
	peerKind := strings.TrimSpace(identity.PeerKind)
	if peerKind == "" {
		peerKind = "direct"
	}
	externalID := strings.ToLower(strings.TrimSpace(identity.ExternalID))
	if agentID == "" || channel == "" || externalID == "" {
		return "", errSessionKeyInvalid
	}
	// 长任务会话不属于前台终止范围；identity 的 externalId 出现 longtask 段也拒绝。
	if strings.Contains(externalID, ":longtask:") {
		return "", errSessionKeyForbidden
	}
	// OpenClaw 渲染 runtime config 时把唯一的 direct 身份写入
	// session.identityLinks[agentId] = [<channel>:<externalId>]，core 以
	// identityLinks 的 canonical key（agentId）作为 direct 会话的 peer；
	// 未链接的 direct/group 身份仍以 externalId 为 peer。
	peerID := externalID
	if peerKind == "direct" {
		peerID = agentID
	}
	sessionKey := fmt.Sprintf("agent:%s:%s:%s:%s", agentID, channel, peerKind, peerID)
	if strings.Contains(sessionKey, ":longtask:") {
		return "", errSessionKeyForbidden
	}
	return sessionKey, nil
}

// sessionCancelCapability 只对 health 已确认可用的 Pod 放行；未知/过期/不可用
// 一律 41007，绝不执行危险兜底。只读 preview 不写操作审计。
func (s *Server) sessionCancelCapability(
	w http.ResponseWriter, r *http.Request, target sessionCancelTarget,
) bool {
	capability, known := s.cancelCapabilities.Lookup(target.podID)
	if known && capability.SessionCancel.Available {
		return true
	}
	writeErr(w, r, errcode.SessionCancelUnsupported)
	return false
}

func validSessionCancelExpected(expected []gateway.SessionCancelExpected) bool {
	// expected 字段必须显式提供（nil 表示缺失）；空数组合法：只 abort run，不杀进程（B-07）。
	if expected == nil {
		return false
	}
	for _, item := range expected {
		if item.PID <= 0 || strings.TrimSpace(item.Fingerprint) == "" {
			return false
		}
	}
	return true
}

// sessionCancelAllSkipped 对应设计中的 41009：本轮没有中止 run、没有杀掉任何
// 进程，且所有 expected 指纹都已失效。若 abort 已生效，进程随 abort 退出属于
// 成功终止，不能报"请重新预览"。
func sessionCancelAllSkipped(result gateway.SessionCancelResult) bool {
	if result.Aborted || result.Confirmed {
		return false
	}
	if result.Killed != 0 || len(result.Processes) == 0 {
		return false
	}
	for _, process := range result.Processes {
		if process.Outcome != "skipped" {
			return false
		}
	}
	return true
}

func sessionCancelErrorCode(err error) int {
	switch {
	case errors.Is(err, gateway.ErrSessionCancelUnsupported):
		return errcode.SessionCancelUnsupported
	case errors.Is(err, gateway.ErrSessionCancelNotFound):
		return errcode.NotFoundSession
	default:
		return errcode.SessionCancelFailed
	}
}

func writeSessionCancelError(w http.ResponseWriter, r *http.Request, err error) {
	code := sessionCancelErrorCode(err)
	if code == errcode.SessionCancelFailed {
		writeRuntimeFailure(w, r, err, code)
		return
	}
	writeErr(w, r, code)
}

// auditSessionCancel 记录目标与结果计数；不写 cmdline/environ/凭证。
func (s *Server) auditSessionCancel(
	r *http.Request, target sessionCancelTarget, result gateway.SessionCancelResult, code int,
) {
	errorCode := ""
	if code != 0 {
		errorCode = strconv.Itoa(code)
	}
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor:  auditlog.AdminActor(actorFrom(r.Context())),
		Action: auditlog.ActionSessionCancel,
		Target: target.identity.IdentityID,
		Metadata: auditlog.Metadata{
			PodID: target.podID, HumanUserID: target.user.HumanUserID,
			AgentID: target.user.AgentID, IdentityID: target.identity.IdentityID,
			SessionKey: target.sessionKey, Aborted: result.Aborted, Drained: result.Drained,
			Killed: result.Killed, Remaining: len(result.Remaining), ErrorCode: errorCode,
		},
	})
	if err != nil {
		log.Printf("session_cancel_audit_failed identity_id=%s error=%s",
			target.identity.IdentityID, auditlog.RedactDiagnostic(err.Error()))
	}
}
