package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	// ErrAgentAlreadyBound is returned when a target Pod already hosts the same
	// agent_id or browser_profile, which would break per-Pod uniqueness.
	ErrAgentAlreadyBound = errors.New("repo: agent already bound in target Pod")
)

// AttachUsers binds previously unbound Human Users to a Pod. Users must be
// unbound (their previous Pod was deleted). Each user keeps its agent_id and
// browser_profile so memory on a recreated Pod links back, receives a fresh
// browser CDP port, and its status is reconciled against active identities on
// channels the target Pod enables. Returns the attached users.
func (s *Store) AttachUsers(humanUserIDs []string, podID string, portStart, portEnd int) ([]HumanUser, error) {
	portStart, portEnd, err := normalizePortRange(portStart, portEnd)
	if err != nil {
		return nil, err
	}
	podID = strings.TrimSpace(podID)
	if podID == "" || len(humanUserIDs) == 0 {
		return nil, ErrInvalidHumanUser
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin attach Human Users: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	pod, err := getPodTx(tx, podID)
	if err != nil {
		return nil, err
	}
	channels, err := podChannelList(pod.Channels)
	if err != nil {
		return nil, err
	}
	users := make([]HumanUser, 0, len(humanUserIDs))
	for _, humanUserID := range humanUserIDs {
		user, err := getHumanUserTx(tx, humanUserID)
		if err != nil {
			return nil, err
		}
		if user.PodID != "" || user.Status == HumanUserStatusDeleting {
			return nil, ErrInvalidStateTransition
		}
		users = append(users, user)
	}
	if err := ensureAvailablePodCapacity(tx, podID, len(users)); err != nil {
		return nil, err
	}
	for i := range users {
		if err := ensureAgentFreeInPodTx(tx, podID, users[i].AgentID, users[i].BrowserProfile); err != nil {
			return nil, err
		}
		port, err := allocateBrowserPort(tx, podID, portStart, portEnd)
		if err != nil {
			return nil, err
		}
		users[i].PodID = podID
		users[i].LastPodID = podID
		users[i].BrowserCDPPort = port
		// Reconcile lifecycle status from identities, but keep an intentionally
		// disabled user disabled (attach is not an explicit re-enable).
		if users[i].Status != HumanUserStatusDisabled {
			status, err := attachUserStatusTx(tx, users[i].HumanUserID, channels)
			if err != nil {
				return nil, err
			}
			users[i].Status = status
		}
		if err := updateHumanUserAttachmentTx(tx, users[i]); err != nil {
			return nil, err
		}
	}
	// markPodSkillsPending so the apply chain syncs the user's private Skill
	// files into the target workspace (config-only pending would leave grants
	// pointing at files that were never copied).
	if err := markPodSkillsPendingTx(tx, podID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit attach Human Users: %w", err)
	}
	return users, nil
}

// ListUnboundHumanUsers returns users whose Pod was deleted (pod_id IS NULL),
// which are the only ones eligible to be attached to another Pod. Users mid
// deletion are excluded.
func (s *Store) ListUnboundHumanUsers() ([]HumanUser, error) {
	rows, err := s.db.Query(`SELECT `+humanUserColumns+`
		FROM human_users WHERE pod_id IS NULL AND status != 'deleting'
		ORDER BY last_pod_id, agent_id`)
	if err != nil {
		return nil, fmt.Errorf("list unbound Human Users: %w", err)
	}
	defer rows.Close()
	return collectHumanUsers(rows)
}

// ListRestorableHumanUsers returns unbound users whose last Pod matches podID.
// A recreated Pod with the same id restores these automatically (agent_id and
// memory are preserved through the retained state PVC).
func (s *Store) ListRestorableHumanUsers(podID string) ([]HumanUser, error) {
	rows, err := s.db.Query(`SELECT `+humanUserColumns+`
		FROM human_users WHERE pod_id IS NULL AND last_pod_id = ?
		AND status != 'deleting' ORDER BY agent_id`, podID)
	if err != nil {
		return nil, fmt.Errorf("list restorable Human Users: %w", err)
	}
	defer rows.Close()
	return collectHumanUsers(rows)
}

func detachPodUsersTx(tx *sql.Tx, podID string) error {
	// Pending binding codes and execution telemetry are Pod-scoped and cascade
	// with the Pod; drop them before detaching so the composite FK
	// (human_user_id, pod_id) on those tables does not block pod_id=NULL.
	if _, err := tx.Exec(`DELETE FROM binding_codes WHERE pod_id = ?`, podID); err != nil {
		return fmt.Errorf("delete Pod binding codes: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM skill_execution_records WHERE pod_id = ?`, podID); err != nil {
		return fmt.Errorf("delete Pod skill executions: %w", err)
	}
	res, err := tx.Exec(`UPDATE human_users SET pod_id = NULL, last_pod_id = ?,
		browser_cdp_port = 0, updated_at = ? WHERE pod_id = ?`,
		podID, formatTime(time.Now().UTC()), podID)
	if err != nil {
		return fmt.Errorf("detach Pod users: %w", err)
	}
	// A Pod with no users is a legitimate no-op; only fail if the Pod is gone.
	count, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("detach Pod users rows affected: %w", err)
	}
	if count == 0 {
		var exists int
		if err := tx.QueryRow(`SELECT 1 FROM pods WHERE pod_id = ?`, podID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("inspect Pod on detach: %w", err)
		}
	}
	return nil
}

func getPodTx(tx *sql.Tx, podID string) (Pod, error) {
	row := tx.QueryRow(`SELECT `+podColumns+` FROM pods WHERE pod_id = ?`, podID)
	return scanPod(row)
}

func podChannelList(channelsJSON string) ([]string, error) {
	var channels []string
	if err := json.Unmarshal([]byte(channelsJSON), &channels); err != nil {
		return nil, fmt.Errorf("decode Pod channels: %w", err)
	}
	return channels, nil
}

func ensureAgentFreeInPodTx(tx *sql.Tx, podID, agentID, browserProfile string) error {
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM human_users
		WHERE pod_id = ? AND (agent_id = ? OR browser_profile = ?)`,
		podID, agentID, browserProfile).Scan(&count); err != nil {
		return fmt.Errorf("check Pod agent conflict: %w", err)
	}
	if count > 0 {
		return ErrAgentAlreadyBound
	}
	return nil
}

// attachUserStatusTx reconciles a freshly attached user: active only when it has
// at least one active identity on a channel the target Pod enables.
func attachUserStatusTx(tx *sql.Tx, humanUserID string, channels []string) (string, error) {
	if len(channels) == 0 {
		return HumanUserStatusPending, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(channels)), ",")
	args := make([]any, 0, len(channels)+1)
	args = append(args, humanUserID)
	for _, channel := range channels {
		args = append(args, channel)
	}
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM user_identities
		WHERE human_user_id = ? AND status = 'active' AND channel IN (`+placeholders+`)`,
		args...).Scan(&count); err != nil {
		return "", fmt.Errorf("count matching active identities: %w", err)
	}
	if count > 0 {
		return HumanUserStatusActive, nil
	}
	return HumanUserStatusPending, nil
}

func updateHumanUserAttachmentTx(tx *sql.Tx, user HumanUser) error {
	res, err := tx.Exec(`UPDATE human_users SET pod_id = ?, last_pod_id = ?,
		browser_cdp_port = ?, status = ?, updated_at = ? WHERE human_user_id = ?`,
		user.PodID, user.LastPodID, user.BrowserCDPPort, user.Status,
		formatTime(time.Now().UTC()), user.HumanUserID)
	return affectedOrNotFound(res, err, "attach Human User")
}
