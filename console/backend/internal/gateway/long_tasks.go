package gateway

import (
	"context"
	"encoding/json"
)

// LongTaskRuntimeTask is one task entry reported by muad.runtime.long-tasks.
type LongTaskRuntimeTask struct {
	TaskID         string
	PoolKey        string
	PoolQueued     int
	PoolRunning    int
	PoolLimit      int
	AgentID        string
	PeerID         string
	SkillName      string
	SkillRoot      string
	Status         string
	SubmittedAt    string
	StartedAt      string
	EndedAt        string
	TerminalReason string
	ErrorCode      string
	UpdatedAt      string
}

type longTaskSnapshotJSON struct {
	Pools []longTaskPoolJSON `json:"pools"`
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
	ID             string `json:"id"`
	PoolKey        string `json:"poolKey"`
	PoolQueued     int    `json:"poolQueued"`
	PoolRunning    int    `json:"poolRunning"`
	PoolLimit      int    `json:"poolLimit"`
	Limit          int    `json:"limit"`
	AgentID        string `json:"agentId"`
	PeerID         string `json:"peerId"`
	SkillName      string `json:"skillName"`
	Skill          string `json:"skill"`
	SkillRoot      string `json:"skillRoot"`
	RootPath       string `json:"rootPath"`
	Status         string `json:"status"`
	SubmittedAt    string `json:"submittedAt"`
	StartedAt      string `json:"startedAt"`
	EndedAt        string `json:"endedAt"`
	TerminalReason string `json:"terminalReason"`
	ErrorCode      string `json:"errorCode"`
	UpdatedAt      string `json:"updatedAt"`
}

// LongTasks fetches the runtime guard's operational queue mirror.
func LongTasks(ctx context.Context, ex Execer, podID string) ([]LongTaskRuntimeTask, error) {
	out, err := ex.Exec(ctx, podID, "openclaw", "gateway", "call", "muad.runtime.long-tasks", "--json")
	if err != nil {
		return nil, err
	}
	var snapshot longTaskSnapshotJSON
	if err := json.Unmarshal([]byte(out), &snapshot); err != nil {
		return nil, err
	}
	return flattenLongTaskSnapshot(snapshot), nil
}

func flattenLongTaskSnapshot(snapshot longTaskSnapshotJSON) []LongTaskRuntimeTask {
	tasks := make([]LongTaskRuntimeTask, 0)
	for _, pool := range snapshot.Pools {
		for _, task := range pool.Tasks {
			tasks = append(tasks, normalizeLongTaskTask(pool, task))
		}
	}
	return tasks
}

func normalizeLongTaskTask(pool longTaskPoolJSON, task longTaskTaskJSON) LongTaskRuntimeTask {
	return LongTaskRuntimeTask{
		TaskID:         firstNonEmpty(task.TaskID, task.ID),
		PoolKey:        firstNonEmpty(task.PoolKey, pool.PoolKey, pool.SessionKey),
		PoolQueued:     pool.Queued,
		PoolRunning:    pool.Active,
		PoolLimit:      firstPositive(task.PoolLimit, task.Limit, pool.Limit),
		AgentID:        firstNonEmpty(task.AgentID, pool.AgentID),
		PeerID:         firstNonEmpty(task.PeerID, pool.PeerID),
		SkillName:      firstNonEmpty(task.SkillName, task.Skill),
		SkillRoot:      firstNonEmpty(task.SkillRoot, task.RootPath),
		Status:         task.Status,
		SubmittedAt:    task.SubmittedAt,
		StartedAt:      task.StartedAt,
		EndedAt:        task.EndedAt,
		TerminalReason: task.TerminalReason,
		ErrorCode:      task.ErrorCode,
		UpdatedAt:      task.UpdatedAt,
	}
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
