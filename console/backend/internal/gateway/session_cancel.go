package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 会话任务终止适配器：集中封装 Driver.Exec 调用与 Worker RPC 包络，供 handler
// 复用；handler 不复制运行时或 Docker/K8s 细节。preview 只读，cancel 有副作用。

// SessionPreviewMethod / SessionCancelMethod 是 Worker 侧 operator.write 内部 RPC。
const (
	SessionPreviewMethod = "muad.session.preview"
	SessionCancelMethod  = "muad.session.cancel"
)

const (
	sessionPreviewTimeout = 10 * time.Second
	sessionCancelTimeout  = 20 * time.Second
	sessionKeyMaxLength   = 256
	operatorMaxLength     = 128
)

var (
	// ErrSessionCancelFailed 表示 RPC 执行失败、超时或响应不可解析：实际状态未知，
	// 调用方不得据此伪报已终止或实际终态。
	ErrSessionCancelFailed = errors.New("session cancel RPC failed")
	// ErrSessionCancelUnsupported 表示旧 Worker / 会话终止能力缺失（unknown method
	// 或 Worker 明确报告能力不可用），必须不执行危险兜底。
	ErrSessionCancelUnsupported = errors.New("session cancel unsupported")
	// ErrSessionCancelNotFound 表示会话/身份不存在或归属不可证明。
	ErrSessionCancelNotFound = errors.New("session not found")
)

// SessionPreviewResult 是 preview RPC 的规范化结果（同 API-01 data）。
type SessionPreviewResult struct {
	SessionKey string           `json:"sessionKey"`
	AgentID    string           `json:"agentId"`
	ActiveRun  SessionActiveRun `json:"activeRun"`
	Processes  []SessionProcess `json:"processes"`
	Skipped    SessionSkipped   `json:"skipped"`
}

type SessionActiveRun struct {
	Active    bool   `json:"active"`
	SessionID string `json:"sessionId,omitempty"`
}

// SessionProcess 是候选进程及其指纹；cancel 时只处理指纹仍匹配的进程。
type SessionProcess struct {
	PID         int    `json:"pid"`
	PGID        int    `json:"pgid"`
	StartTime   int64  `json:"startTime"`
	UID         int    `json:"uid"`
	Leader      bool   `json:"leader"`
	AgeSeconds  int64  `json:"ageSeconds"`
	Cmdline     string `json:"cmdline"`
	Fingerprint string `json:"fingerprint"`
}

type SessionSkipped struct {
	NotOwner         int `json:"notOwner"`
	EnvMismatch      int `json:"envMismatch"`
	PermissionDenied int `json:"permissionDenied"`
}

// SessionCancelExpected 是前端二次确认后回传的进程指纹。
type SessionCancelExpected struct {
	PID         int    `json:"pid"`
	Fingerprint string `json:"fingerprint"`
}

// SessionCancelResult 是 cancel RPC 的规范化结果（同 API-02 data）。
type SessionCancelResult struct {
	Aborted   bool                   `json:"aborted"`
	Drained   bool                   `json:"drained"`
	Confirmed bool                   `json:"confirmed"`
	Killed    int                    `json:"killed"`
	Remaining []int                  `json:"remaining"`
	Processes []SessionCancelProcess `json:"processes"`
}

type SessionCancelProcess struct {
	PID     int    `json:"pid"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
}

type sessionPreviewParams struct {
	SessionKey  string `json:"sessionKey"`
	RequestedBy string `json:"requestedBy"`
}

type sessionCancelParams struct {
	SessionKey  string                  `json:"sessionKey"`
	RequestedBy string                  `json:"requestedBy"`
	Expected    []SessionCancelExpected `json:"expected"`
}

// sessionRPCEnvelope 兼容 Worker 的三种返回形状：直接 data、扁平 {ok,...} 与
// {ok,data} 包装；ok 缺失按直接 data 处理。
type sessionRPCEnvelope struct {
	OK     *bool           `json:"ok"`
	Reason string          `json:"reason"`
	Data   json.RawMessage `json:"data"`
}

// PreviewSessionCancel 只读预览会话任务：参数以 argv + 编码后的 JSON 安全传递
// （不拼 Shell），调用带 10s context deadline。
func PreviewSessionCancel(
	ctx context.Context, ex Execer, podID, sessionKey, requestedBy string,
) (SessionPreviewResult, error) {
	key, operator, err := validateSessionRequest(sessionKey, requestedBy)
	if err != nil {
		return SessionPreviewResult{}, err
	}
	payload, err := json.Marshal(sessionPreviewParams{SessionKey: key, RequestedBy: operator})
	if err != nil {
		return SessionPreviewResult{}, fmt.Errorf("%w: %w", ErrSessionCancelFailed, err)
	}
	out, err := callSessionRPC(ctx, ex, podID, SessionPreviewMethod, payload, sessionPreviewTimeout)
	if err != nil {
		return SessionPreviewResult{}, err
	}
	var result SessionPreviewResult
	if err := decodeSessionRPC(out, &result); err != nil {
		return SessionPreviewResult{}, err
	}
	if result.SessionKey == "" {
		return SessionPreviewResult{}, fmt.Errorf("%w: preview response missing sessionKey", ErrSessionCancelFailed)
	}
	return result, nil
}

// CancelSessionCancel 终止会话任务：只处理 expected 中指纹仍匹配的进程；调用带
// 20s context deadline，超时/不可解析一律返回 ErrSessionCancelFailed。
func CancelSessionCancel(
	ctx context.Context, ex Execer, podID, sessionKey, requestedBy string,
	expected []SessionCancelExpected,
) (SessionCancelResult, error) {
	key, operator, err := validateSessionRequest(sessionKey, requestedBy)
	if err != nil {
		return SessionCancelResult{}, err
	}
	if len(expected) == 0 {
		return SessionCancelResult{}, fmt.Errorf("%w: empty expected process list", ErrSessionCancelFailed)
	}
	for _, item := range expected {
		if item.PID <= 0 || strings.TrimSpace(item.Fingerprint) == "" {
			return SessionCancelResult{}, fmt.Errorf("%w: invalid expected process fingerprint", ErrSessionCancelFailed)
		}
	}
	payload, err := json.Marshal(sessionCancelParams{
		SessionKey: key, RequestedBy: operator, Expected: expected,
	})
	if err != nil {
		return SessionCancelResult{}, fmt.Errorf("%w: %w", ErrSessionCancelFailed, err)
	}
	out, err := callSessionRPC(ctx, ex, podID, SessionCancelMethod, payload, sessionCancelTimeout)
	if err != nil {
		return SessionCancelResult{}, err
	}
	var result SessionCancelResult
	if err := decodeSessionRPC(out, &result); err != nil {
		return SessionCancelResult{}, err
	}
	return result, nil
}

func validateSessionRequest(sessionKey, requestedBy string) (string, string, error) {
	key := strings.TrimSpace(sessionKey)
	operator := strings.TrimSpace(requestedBy)
	if key == "" || operator == "" ||
		len(key) > sessionKeyMaxLength || len(operator) > operatorMaxLength {
		return "", "", fmt.Errorf("%w: invalid session cancel request identity", ErrSessionCancelFailed)
	}
	return key, operator, nil
}

func callSessionRPC(
	ctx context.Context, ex Execer, podID, method string, payload []byte, timeout time.Duration,
) (string, error) {
	bounded := ctx
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		bounded, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	out, err := ex.Exec(
		bounded, podID, "openclaw", "gateway", "call", method,
		"--params", string(payload), "--json",
	)
	if err != nil {
		if isUnknownRPCMethod(err) {
			return "", fmt.Errorf("%w: %w", ErrSessionCancelUnsupported, err)
		}
		return "", fmt.Errorf("%w: %w", ErrSessionCancelFailed, err)
	}
	return out, nil
}

func decodeSessionRPC(out string, target any) error {
	var envelope sessionRPCEnvelope
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		return fmt.Errorf("%w: %w", ErrSessionCancelFailed, err)
	}
	if envelope.OK != nil && !*envelope.OK {
		return mapSessionRPCReason(envelope.Reason)
	}
	payload := []byte(out)
	if envelope.OK != nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		payload = envelope.Data
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return fmt.Errorf("%w: %w", ErrSessionCancelFailed, err)
	}
	return nil
}

func mapSessionRPCReason(reason string) error {
	switch reason {
	case "not_found", "session_not_found", "identity_not_found", "unknown_session":
		return fmt.Errorf("%w: reason=%s", ErrSessionCancelNotFound, reason)
	case "cancel_unavailable", "not_available", "unsupported", "session_cancel_unavailable",
		"method_not_found", "unknown_method":
		return fmt.Errorf("%w: reason=%s", ErrSessionCancelUnsupported, reason)
	default:
		return fmt.Errorf("%w: reason=%s", ErrSessionCancelFailed, reason)
	}
}
