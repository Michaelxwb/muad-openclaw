package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 长任务取消适配器：集中封装 Driver.Exec 调用与 Worker RPC 包络，供 handler 与
// 列表复用；handler 不复制运行时或 Docker/K8s 细节。

// LongTaskCancelMethod 是 Worker 侧 operator.write 内部取消 RPC。
const LongTaskCancelMethod = "muad.long-task.cancel"

const defaultCancelTimeout = 10 * time.Second

var (
	// ErrLongTaskCancelRPC 表示 RPC 执行失败或响应不可解析：实际状态未知，调用方
	// 不得据此伪报已取消或实际终态。
	ErrLongTaskCancelRPC = errors.New("long task cancel RPC failed")
	// ErrLongTaskCancelUnsupported 表示旧 Worker / 取消能力缺失（unknown method 或
	// Worker 明确报告取消链不可用），必须不执行危险兜底。
	ErrLongTaskCancelUnsupported = errors.New("long task cancel unsupported")
	// ErrLongTaskCancelNotFound 表示任务身份不存在或归属不可证明。
	ErrLongTaskCancelNotFound = errors.New("long task not found")
	// ErrLongTaskCancelRejected 表示请求被 Worker 明确拒绝（畸形/越界请求）。
	ErrLongTaskCancelRejected = errors.New("long task cancel rejected")
	// ErrLongTaskCancelStateFailed 表示 Worker 无法可靠保存取消记录：不接受取消
	// 成功，也不得伪报已取消。
	ErrLongTaskCancelStateFailed = errors.New("long task cancel state write failed")
)

// LongTaskCancelResult 是取消 RPC 的规范化结果。AlreadyTerminal 为真时 Status 是
// 原样回传的实际终态（不改写为已取消）。
type LongTaskCancelResult struct {
	Outcome         string
	Status          string
	StateRevision   int64
	AlreadyTerminal bool
}

type longTaskCancelParams struct {
	TaskID      string `json:"taskId"`
	RequestedBy string `json:"requestedBy"`
}

type longTaskCancelEnvelope struct {
	OK            bool   `json:"ok"`
	Outcome       string `json:"outcome"`
	Status        string `json:"status"`
	StateRevision *int64 `json:"stateRevision"`
	Reason        string `json:"reason"`
}

// CancelLongTask 通过现有 Driver.Exec 调用内部取消 RPC：参数以 argv + 编码后的
// JSON 安全传递（不拼 Shell），调用带 context deadline；旧 Worker、身份未知、
// 取消已接受、已取消与真实终态分别映射为稳定结果/错误，并保留原错误链供脱敏诊断。
func CancelLongTask(
	ctx context.Context, ex Execer, podID, taskID, requestedBy string,
) (LongTaskCancelResult, error) {
	task := strings.TrimSpace(taskID)
	operator := strings.TrimSpace(requestedBy)
	if task == "" || operator == "" || len(task) > 128 || len(operator) > 128 {
		return LongTaskCancelResult{}, fmt.Errorf("%w: invalid cancel request identity", ErrLongTaskCancelRejected)
	}
	payload, err := json.Marshal(longTaskCancelParams{TaskID: task, RequestedBy: operator})
	if err != nil {
		return LongTaskCancelResult{}, fmt.Errorf("%w: %w", ErrLongTaskCancelRPC, err)
	}
	bounded := ctx
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		bounded, cancel = context.WithTimeout(ctx, defaultCancelTimeout)
		defer cancel()
	}
	out, err := ex.Exec(
		bounded, podID, "openclaw", "gateway", "call", LongTaskCancelMethod,
		"--params", string(payload), "--json",
	)
	if err != nil {
		if isUnknownRPCMethod(err) {
			return LongTaskCancelResult{}, fmt.Errorf("%w: %w", ErrLongTaskCancelUnsupported, err)
		}
		return LongTaskCancelResult{}, fmt.Errorf("%w: %w", ErrLongTaskCancelRPC, err)
	}
	var envelope longTaskCancelEnvelope
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		return LongTaskCancelResult{}, fmt.Errorf("%w: %w", ErrLongTaskCancelRPC, err)
	}
	revision := int64(0)
	if envelope.StateRevision != nil && *envelope.StateRevision > 0 {
		revision = *envelope.StateRevision
	}
	if envelope.OK {
		return LongTaskCancelResult{
			Outcome: envelope.Outcome, Status: envelope.Status, StateRevision: revision,
		}, nil
	}
	switch envelope.Reason {
	case "already_terminal":
		return LongTaskCancelResult{
			Status: envelope.Status, StateRevision: revision, AlreadyTerminal: true,
		}, nil
	case "not_found":
		return LongTaskCancelResult{}, ErrLongTaskCancelNotFound
	case "cancel_unavailable", "not_available":
		return LongTaskCancelResult{}, ErrLongTaskCancelUnsupported
	case "state_unavailable":
		return LongTaskCancelResult{}, ErrLongTaskCancelStateFailed
	case "invalid_request":
		return LongTaskCancelResult{}, ErrLongTaskCancelRejected
	default:
		return LongTaskCancelResult{}, fmt.Errorf("%w: reason=%s", ErrLongTaskCancelRPC, envelope.Reason)
	}
}

func isUnknownRPCMethod(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "unknown method") ||
		strings.Contains(text, "method not found") ||
		strings.Contains(text, "unsupported method")
}
