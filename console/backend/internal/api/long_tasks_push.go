package api

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// The runtime guard pushes its full long-task snapshot on every state
// transition (queued -> running -> succeeded/failed). The snapshot DTO mirrors
// the guard payload exactly: decodeJSONBody rejects unknown fields, so every
// field the guard serializes must be declared here even if it is not persisted.
type longTaskSnapshotJSON struct {
	Active int                `json:"active"`
	Queued int                `json:"queued"`
	Limit  int                `json:"limit"`
	Pools  []longTaskPoolJSON `json:"pools"`
}

type longTaskPoolJSON struct {
	PoolKey    string             `json:"poolKey"`
	SessionKey string             `json:"sessionKey"`
	AgentID    string             `json:"agentId"`
	PeerID     string             `json:"peerId"`
	Queued     int                `json:"queued"`
	Active     int                `json:"active"`
	Limit      int                `json:"limit"`
	Tasks      []longTaskTaskJSON `json:"tasks"`
}

type longTaskTaskJSON struct {
	TaskID         string `json:"taskId"`
	PoolKey        string `json:"poolKey"`
	SessionKey     string `json:"sessionKey"`
	AgentID        string `json:"agentId"`
	PeerID         string `json:"peerId"`
	SkillName      string `json:"skillName"`
	SkillRoot      string `json:"skillRoot"`
	Status         string `json:"status"`
	SourceSessKey  string `json:"sourceSessionKey"`
	SubmittedAt    string `json:"submittedAt"`
	StartedAt      string `json:"startedAt"`
	EndedAt        string `json:"endedAt"`
	TerminalReason string `json:"terminalReason"`
	ErrorCode      string `json:"errorCode"`
	UpdatedAt      string `json:"updatedAt"`
}

func (s *Server) handleUpsertLongTasks(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, r, errcode.UnauthorizedPodToken)
		return
	}
	var snapshot longTaskSnapshotJSON
	if err := decodeJSONBody(w, r, &snapshot); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	tasks := s.longTaskTasksFromSnapshot(pod.PodID, snapshot)
	if err := s.store.UpsertLongTaskTasks(tasks); err != nil {
		if errors.Is(err, repo.ErrInvalidSkill) {
			// guard 推送的数据无效（skillName 非法等）属请求体问题，而非"无效 Skill"客户端错误。
			writeErr(w, r, errcode.InvalidRequestBody)
		} else {
			writeErr(w, r, errcode.InternalUpsertLongTasks)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": len(tasks)})
}

func (s *Server) longTaskTasksFromSnapshot(
	podID string, snapshot longTaskSnapshotJSON,
) []repo.LongTaskTask {
	userIDs := s.humanUserIDsByAgent(podID)
	tasks := make([]repo.LongTaskTask, 0)
	for _, pool := range snapshot.Pools {
		for _, task := range pool.Tasks {
			tasks = append(tasks, longTaskTaskFromJSON(podID, pool, task, userIDs))
		}
	}
	return tasks
}

func (s *Server) humanUserIDsByAgent(podID string) map[string]string {
	users, _, err := s.store.ListHumanUsersByPod(podID, repo.HumanUserListFilter{})
	if err != nil {
		log.Printf("long_task_human_user_lookup_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(err.Error()))
		return map[string]string{}
	}
	index := make(map[string]string, len(users))
	for _, user := range users {
		index[user.AgentID] = user.HumanUserID
	}
	return index
}

func longTaskTaskFromJSON(
	podID string, pool longTaskPoolJSON, task longTaskTaskJSON, userIDs map[string]string,
) repo.LongTaskTask {
	agentID := firstNonEmpty(task.AgentID, pool.AgentID)
	return repo.LongTaskTask{
		TaskID:         task.TaskID,
		PodID:          podID,
		HumanUserID:    userIDs[agentID],
		PoolKey:        firstNonEmpty(task.PoolKey, pool.PoolKey, pool.SessionKey),
		PoolQueued:     pool.Queued,
		PoolRunning:    pool.Active,
		PoolLimit:      pool.Limit,
		AgentID:        agentID,
		PeerID:         firstNonEmpty(task.PeerID, pool.PeerID),
		SkillName:      task.SkillName,
		SkillRoot:      task.SkillRoot,
		Status:         strings.TrimSpace(task.Status),
		SubmittedAt:    parseRuntimeTime(task.SubmittedAt),
		StartedAt:      parseRuntimeTime(task.StartedAt),
		EndedAt:        parseRuntimeTime(task.EndedAt),
		TerminalReason: task.TerminalReason,
		ErrorCode:      task.ErrorCode,
		UpdatedAt:      parseRuntimeTime(task.UpdatedAt),
		LastSeenAt:     time.Now().UTC(),
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func parseRuntimeTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
