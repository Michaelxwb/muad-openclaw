package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const longTaskCancelRequestTimeout = 15 * time.Second

// handleCancelLongTask 实现 API-01：POST /api/v1/long-tasks/{taskId}/cancel，空请求体。
// 客户端只提供 taskId；Pod/Agent/归属全部来自可信 Store，请求体不得影响运行归属。
// 终态任务直接回传实际终态（零运行调用）；取消经 gateway 适配器走 Driver.Exec；
// 失败一律不改写 Store（镜像只由 Worker 快照前进），操作结果进独立审计。
func (s *Server) handleCancelLongTask(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.PathValue("taskId"))
	if taskID == "" || len(taskID) > 128 {
		writeErr(w, r, errcode.NotFoundLongTask)
		return
	}
	if !readEmptyCancelBody(w, r) {
		return
	}
	task, err := s.store.GetLongTaskTask(taskID)
	if errors.Is(err, repo.ErrNotFound) {
		writeErr(w, r, errcode.NotFoundLongTask)
		return
	}
	if err != nil {
		writeRuntimeFailure(w, r, err, errcode.InternalError)
		return
	}
	if longTaskTaskIsTerminal(task.Status) {
		s.auditLongTaskCancel(r, task, "already_terminal", "")
		writeLongTaskCancelResult(w, task.TaskID, "already_terminal", task.Status, int64(task.StateRevision))
		return
	}
	// 能力未知/过期/不支持一律不可取消（不推断 canCancel=true），也不执行危险兜底。
	capability, known := s.longTaskCapabilities.Lookup(task.PodID)
	if !known || !capability.Available {
		s.auditLongTaskCancel(r, task, "rejected", "cancel_unavailable")
		writeErr(w, r, errcode.LongTaskCancelUnsupported)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), longTaskCancelRequestTimeout)
	defer cancel()
	result, err := gateway.CancelLongTask(ctx, s.drv, task.PodID, task.TaskID, actorFrom(r.Context()))
	switch {
	case err == nil:
	case errors.Is(err, gateway.ErrLongTaskCancelNotFound):
		s.auditLongTaskCancel(r, task, "rejected", "not_found")
		writeErr(w, r, errcode.NotFoundLongTask)
		return
	case errors.Is(err, gateway.ErrLongTaskCancelUnsupported):
		s.auditLongTaskCancel(r, task, "rejected", "cancel_unavailable")
		writeErr(w, r, errcode.LongTaskCancelUnsupported)
		return
	case errors.Is(err, gateway.ErrLongTaskCancelStateFailed):
		s.auditLongTaskCancel(r, task, "failed", "state_unavailable")
		writeRuntimeFailure(w, r, err, errcode.LongTaskCancelStateFailed)
		return
	default:
		s.auditLongTaskCancel(r, task, "failed", "rpc_unavailable")
		writeRuntimeFailure(w, r, err, errcode.LongTaskCancelUnavailable)
		return
	}
	outcome := result.Outcome
	if result.AlreadyTerminal {
		outcome = "already_terminal"
	}
	s.auditLongTaskCancel(r, task, outcome, "")
	writeLongTaskCancelResult(w, task.TaskID, outcome, result.Status, result.StateRevision)
}

// readEmptyCancelBody 只接受空请求体或空对象：任何其他字段（如试图伪造
// Pod/Agent 的载荷）都是畸形请求，拒绝且不产生运行调用。
func readEmptyCancelBody(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return false
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return true
	}
	var payload map[string]any
	if json.Unmarshal([]byte(trimmed), &payload) != nil || len(payload) != 0 {
		writeErr(w, r, errcode.InvalidRequestBody)
		return false
	}
	return true
}

func longTaskTaskIsTerminal(status string) bool {
	switch status {
	case repo.LongTaskSucceeded, repo.LongTaskFailed, repo.LongTaskCancelled:
		return true
	default:
		return false
	}
}

// auditLongTaskCancel 记录取消操作审计（业务操作审计，与 Skill 进度 telemetry 分离）：
// 仅任务归属字段与稳定状态/错误码，不写请求原文、命令或凭证。
func (s *Server) auditLongTaskCancel(r *http.Request, task repo.LongTaskTask, status, errorCode string) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor:  auditlog.AdminActor(actorFrom(r.Context())),
		Action: auditlog.ActionLongTaskCancel,
		Target: task.TaskID,
		Metadata: auditlog.Metadata{
			PodID: task.PodID, HumanUserID: task.HumanUserID, AgentID: task.AgentID,
			SkillName: task.SkillName, Status: status, ErrorCode: errorCode,
		},
	})
	if err != nil {
		log.Printf("long_task_cancel_audit_failed task_id=%s status=%s error=%v", task.TaskID, status, err)
	}
}
