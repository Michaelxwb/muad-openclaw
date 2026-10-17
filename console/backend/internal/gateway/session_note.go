package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SessionNoteMethod 是 OpenClaw 的 transcript-only 注记方法：把一条 assistant
// 注记写入会话历史，不启动 agent run、不向 IM 通道投递。用于在管理员终止任务后
// 给下一轮模型一个权威事实，避免它把被杀掉的进程 session 误判为模型执行失败。
const SessionNoteMethod = "chat.inject"

const (
	sessionNoteTimeout   = 10 * time.Second
	sessionNoteMaxLength = 2000
	sessionNoteLabel     = "muad.session-cancel"
)

// InjectSessionNote 向目标会话追加一条 assistant 注记。失败不改变终止结果，
// 由调用方记录诊断后继续返回 cancel 结果。
func InjectSessionNote(
	ctx context.Context, ex Execer, podID, sessionKey, message string,
) error {
	key := strings.TrimSpace(sessionKey)
	text := strings.TrimSpace(message)
	if key == "" || text == "" || len(key) > sessionKeyMaxLength || len(text) > sessionNoteMaxLength {
		return fmt.Errorf("invalid session note request")
	}
	payload, err := json.Marshal(map[string]string{
		"sessionKey": key,
		"message":    text,
		"label":      sessionNoteLabel,
	})
	if err != nil {
		return fmt.Errorf("marshal session note: %w", err)
	}
	out, err := callSessionRPC(ctx, ex, podID, SessionNoteMethod, payload, sessionNoteTimeout)
	if err != nil {
		return err
	}
	var envelope struct {
		OK *bool `json:"ok"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		return fmt.Errorf("decode session note response: %w", err)
	}
	if envelope.OK == nil || !*envelope.OK {
		return fmt.Errorf("session note rejected")
	}
	return nil
}
