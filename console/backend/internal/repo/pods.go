package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	// ErrPodExists is returned for a duplicate Pod ID or service-token fingerprint.
	ErrPodExists = errors.New("repo: pod already exists")
	// ErrGenerationConflict means an apply result targets a stale generation.
	ErrGenerationConflict = errors.New("repo: pod config generation conflict")
)

const podColumns = `pod_id, display_name, image_tag, state, max_users, channels,
	channel_configs_enc, mem_limit, cpu_limit, restart_policy,
	max_skill_concurrency, max_browser_concurrency, service_token_enc,
	service_token_fingerprint, service_token_rotated_at, config_generation,
	applied_generation, last_config_hash, last_apply_status, last_apply_error,
	last_applied_at, created_at, updated_at`

const podColumnsWithAlias = `p.pod_id, p.display_name, p.image_tag, p.state, p.max_users, p.channels,
	p.channel_configs_enc, p.mem_limit, p.cpu_limit, p.restart_policy,
	p.max_skill_concurrency, p.max_browser_concurrency, p.service_token_enc,
	p.service_token_fingerprint, p.service_token_rotated_at, p.config_generation,
	p.applied_generation, p.last_config_hash, p.last_apply_status, p.last_apply_error,
	p.last_applied_at, p.created_at, p.updated_at`

// PodListFilter controls Repository-level Pod pagination and filtering.
type PodListFilter struct {
	Offset int
	Limit  int
	State  string
	Query  string
}

// PodSummary includes capacity data computed in the same list query.
type PodSummary struct {
	Pod
	UserCount      int
	AvailableSlots int
}

// PodUpdate contains fields mutable through the normal Pod update path.
type PodUpdate struct {
	DisplayName           string
	ImageTag              string
	MaxUsers              int
	Channels              string
	ChannelConfigsEnc     string
	MemLimit              string
	CPULimit              string
	RestartPolicy         string
	MaxSkillConcurrency   int
	MaxBrowserConcurrency int
}

// PodResourceUpdate contains only resource and runtime-concurrency overrides.
type PodResourceUpdate struct {
	MemLimit              string
	CPULimit              string
	RestartPolicy         string
	MaxSkillConcurrency   int
	MaxBrowserConcurrency int
}

// CreatePod inserts a Pod with an already encrypted service token.
func (s *Store) CreatePod(p Pod) error {
	now := time.Now().UTC()
	applyPodDefaults(&p, now)
	_, err := s.db.Exec(`INSERT INTO pods (
		pod_id, display_name, image_tag, state, max_users, channels,
		channel_configs_enc, mem_limit, cpu_limit, restart_policy,
		max_skill_concurrency, max_browser_concurrency, service_token_enc,
		service_token_fingerprint, service_token_rotated_at, config_generation,
		applied_generation, last_config_hash, last_apply_status, last_apply_error,
		last_applied_at, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.PodID, p.DisplayName, p.ImageTag, p.State, p.MaxUsers, p.Channels,
		p.ChannelConfigsEnc, p.MemLimit, p.CPULimit, p.RestartPolicy,
		p.MaxSkillConcurrency, p.MaxBrowserConcurrency, p.ServiceTokenEnc,
		p.ServiceTokenFingerprint, formatTime(p.ServiceTokenRotatedAt), p.ConfigGeneration,
		p.AppliedGeneration, p.LastConfigHash, p.LastApplyStatus, p.LastApplyError,
		formatOptionalTime(p.LastAppliedAt), formatTime(p.CreatedAt), formatTime(p.UpdatedAt),
	)
	if isUniqueConstraint(err) {
		return ErrPodExists
	}
	if err != nil {
		return fmt.Errorf("create Pod %s: %w", p.PodID, err)
	}
	return nil
}

// GetPod returns one Pod or ErrNotFound.
func (s *Store) GetPod(podID string) (Pod, error) {
	row := s.db.QueryRow(`SELECT `+podColumns+` FROM pods WHERE pod_id = ?`, podID)
	return scanPod(row)
}

// GetPodSummary returns one Pod with its capacity counters in one query.
func (s *Store) GetPodSummary(podID string) (PodSummary, error) {
	row := s.db.QueryRow(`SELECT `+podColumnsWithAlias+`, COUNT(h.human_user_id)
		FROM pods p LEFT JOIN human_users h ON h.pod_id = p.pod_id
		AND h.status IN ('active','pending') WHERE p.pod_id = ? GROUP BY p.pod_id`, podID)
	var userCount int
	pod, err := scanPodValues(row, &userCount)
	if err != nil {
		return PodSummary{}, err
	}
	return PodSummary{Pod: pod, UserCount: userCount, AvailableSlots: max(0, pod.MaxUsers-userCount)}, nil
}

// FindPodByServiceTokenFingerprint returns the indexed token candidate.
func (s *Store) FindPodByServiceTokenFingerprint(fingerprint string) (Pod, error) {
	row := s.db.QueryRow(
		`SELECT `+podColumns+` FROM pods WHERE service_token_fingerprint = ?`,
		fingerprint,
	)
	return scanPod(row)
}

// ListPods returns filtered Pods and capacity using one aggregate list query.
func (s *Store) ListPods(filter PodListFilter) ([]PodSummary, int, error) {
	where, args := podFilterSQL(filter)
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pods p`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count Pods: %w", err)
	}
	query := `SELECT ` + podColumnsWithAlias + `,
		COUNT(h.human_user_id)
		FROM pods p
		LEFT JOIN human_users h ON h.pod_id = p.pod_id AND h.status IN ('active','pending')` +
		where + ` GROUP BY p.pod_id ORDER BY p.pod_id`
	listArgs := append([]any(nil), args...)
	if filter.Limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		listArgs = append(listArgs, filter.Limit, filter.Offset)
	}
	rows, err := s.db.Query(query, listArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list Pods: %w", err)
	}
	defer rows.Close()
	items, err := collectPodSummaries(rows)
	return items, total, err
}

// UpdatePod replaces mutable fields and atomically marks a new generation pending.
func (s *Store) UpdatePod(podID string, update PodUpdate) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin update Pod: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := ensurePodCapacity(tx, podID, update.MaxUsers, 0); err != nil {
		return err
	}
	now := formatTime(time.Now().UTC())
	res, err := tx.Exec(`UPDATE pods SET
		display_name = ?, image_tag = ?, max_users = ?, channels = ?,
		channel_configs_enc = ?, mem_limit = ?, cpu_limit = ?,
		restart_policy = ?, max_skill_concurrency = ?, max_browser_concurrency = ?,
		config_generation = config_generation + 1, last_apply_status = 'pending',
		last_apply_error = '', updated_at = ? WHERE pod_id = ?`,
		update.DisplayName, update.ImageTag, update.MaxUsers, update.Channels,
		update.ChannelConfigsEnc, update.MemLimit, update.CPULimit,
		update.RestartPolicy, update.MaxSkillConcurrency, update.MaxBrowserConcurrency,
		now, podID,
	)
	if err := affectedOrNotFound(res, err, "update Pod"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit update Pod: %w", err)
	}
	return nil
}

// UpdatePodResources updates only resource fields and returns the new generation.
func (s *Store) UpdatePodResources(podID string, update PodResourceUpdate) (int64, error) {
	row := s.db.QueryRow(`UPDATE pods SET mem_limit = ?, cpu_limit = ?, restart_policy = ?,
		max_skill_concurrency = ?, max_browser_concurrency = ?,
		config_generation = config_generation + 1, last_apply_status = 'pending',
		last_apply_error = '', updated_at = ? WHERE pod_id = ?
		RETURNING config_generation`, update.MemLimit, update.CPULimit,
		update.RestartPolicy, update.MaxSkillConcurrency, update.MaxBrowserConcurrency,
		formatTime(time.Now().UTC()), podID)
	var generation int64
	if err := row.Scan(&generation); errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	} else if err != nil {
		return 0, fmt.Errorf("update Pod resources: %w", err)
	}
	return generation, nil
}

// MarkPodsInheritingResourcesPending updates all Pods affected by global changes.
func (s *Store) MarkPodsInheritingResourcesPending(
	memChanged, cpuChanged, restartChanged bool,
) ([]string, error) {
	if !memChanged && !cpuChanged && !restartChanged {
		return []string{}, nil
	}
	rows, err := s.db.Query(`UPDATE pods SET config_generation = config_generation + 1,
		last_apply_status = 'pending', last_apply_error = '', updated_at = ?
		WHERE (? AND mem_limit = '') OR (? AND cpu_limit = '') OR (? AND restart_policy = '')
		RETURNING pod_id`, formatTime(time.Now().UTC()), memChanged, cpuChanged, restartChanged)
	if err != nil {
		return nil, fmt.Errorf("mark inheriting Pods pending: %w", err)
	}
	defer rows.Close()
	var podIDs []string
	for rows.Next() {
		var podID string
		if err := rows.Scan(&podID); err != nil {
			return nil, fmt.Errorf("scan inheriting Pod: %w", err)
		}
		podIDs = append(podIDs, podID)
	}
	return podIDs, rows.Err()
}

// UpdatePodState changes only the observed control-plane lifecycle state.
func (s *Store) UpdatePodState(podID, state string) error {
	res, err := s.db.Exec(
		`UPDATE pods SET state = ?, updated_at = ? WHERE pod_id = ?`,
		state, formatTime(time.Now().UTC()), podID,
	)
	return affectedOrNotFound(res, err, "update Pod state")
}

// DeletePod deletes the aggregate; foreign keys cascade owned records.
func (s *Store) DeletePod(podID string) error {
	res, err := s.db.Exec(`DELETE FROM pods WHERE pod_id = ?`, podID)
	return affectedOrNotFound(res, err, "delete Pod")
}

// RotatePodServiceToken atomically replaces encrypted token material.
func (s *Store) RotatePodServiceToken(podID, encrypted, fingerprint string, rotatedAt time.Time) error {
	res, err := s.db.Exec(`UPDATE pods SET service_token_enc = ?,
		service_token_fingerprint = ?, service_token_rotated_at = ?, updated_at = ?
		WHERE pod_id = ?`, encrypted, fingerprint, formatTime(rotatedAt),
		formatTime(time.Now().UTC()), podID)
	if isUniqueConstraint(err) {
		return ErrPodExists
	}
	return affectedOrNotFound(res, err, "rotate Pod service token")
}

// MarkPodConfigPending increments the desired generation and returns it.
func (s *Store) MarkPodConfigPending(podID string) (int64, error) {
	row := s.db.QueryRow(`UPDATE pods SET config_generation = config_generation + 1,
		last_apply_status = 'pending', last_apply_error = '', updated_at = ?
		WHERE pod_id = ? RETURNING config_generation`, formatTime(time.Now().UTC()), podID)
	var generation int64
	if err := row.Scan(&generation); errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	} else if err != nil {
		return 0, fmt.Errorf("mark Pod config pending: %w", err)
	}
	return generation, nil
}

// StartPodConfigApply claims the current expected generation.
func (s *Store) StartPodConfigApply(podID string, generation int64) error {
	res, err := s.db.Exec(`UPDATE pods SET last_apply_status = 'applying',
		last_apply_error = '', updated_at = ? WHERE pod_id = ?
		AND config_generation = ? AND applied_generation < ?`,
		formatTime(time.Now().UTC()), podID, generation, generation)
	return s.configMutationResult(podID, res, err, "start Pod config apply")
}

// CompletePodConfigApply records only a result for the still-current generation.
func (s *Store) CompletePodConfigApply(podID string, generation int64, hash string, appliedAt time.Time) error {
	res, err := s.db.Exec(`UPDATE pods SET applied_generation = ?,
		last_config_hash = ?, last_apply_status = 'applied', last_apply_error = '',
		last_applied_at = ?, updated_at = ? WHERE pod_id = ? AND config_generation = ?`,
		generation, hash, formatTime(appliedAt), formatTime(time.Now().UTC()), podID, generation)
	return s.configMutationResult(podID, res, err, "complete Pod config apply")
}

// FailPodConfigApply records a failure without replacing the last valid hash.
func (s *Store) FailPodConfigApply(podID string, generation int64, message string) error {
	res, err := s.db.Exec(`UPDATE pods SET last_apply_status = 'failed',
		last_apply_error = ?, updated_at = ? WHERE pod_id = ? AND config_generation = ?`,
		message, formatTime(time.Now().UTC()), podID, generation)
	return s.configMutationResult(podID, res, err, "fail Pod config apply")
}

// ListPodsNeedingApply supports startup recovery of unconverged Pods.
func (s *Store) ListPodsNeedingApply() ([]Pod, error) {
	rows, err := s.db.Query(`SELECT ` + podColumns + ` FROM pods
		WHERE applied_generation < config_generation
		AND last_apply_status IN ('pending','applying','failed') ORDER BY pod_id`)
	if err != nil {
		return nil, fmt.Errorf("list Pods needing apply: %w", err)
	}
	defer rows.Close()
	var pods []Pod
	for rows.Next() {
		pod, err := scanPod(rows)
		if err != nil {
			return nil, err
		}
		pods = append(pods, pod)
	}
	return pods, rows.Err()
}

func applyPodDefaults(p *Pod, now time.Time) {
	if p.State == "" {
		p.State = PodStateCreating
	}
	if p.MaxUsers == 0 {
		p.MaxUsers = 10
	}
	if p.Channels == "" {
		p.Channels = "[]"
	}
	if p.ConfigGeneration == 0 {
		p.ConfigGeneration = 1
	}
	if p.LastApplyStatus == "" {
		p.LastApplyStatus = ApplyStatusPending
	}
	if p.ServiceTokenRotatedAt.IsZero() {
		p.ServiceTokenRotatedAt = now
	}
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
}

func podFilterSQL(filter PodListFilter) (string, []any) {
	clauses := []string{"1 = 1"}
	args := make([]any, 0, 3)
	if filter.State != "" {
		clauses = append(clauses, "p.state = ?")
		args = append(args, filter.State)
	}
	if query := strings.TrimSpace(filter.Query); query != "" {
		clauses = append(clauses, "(p.pod_id LIKE ? OR p.display_name LIKE ?)")
		pattern := "%" + query + "%"
		args = append(args, pattern, pattern)
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func collectPodSummaries(rows *sql.Rows) ([]PodSummary, error) {
	var items []PodSummary
	for rows.Next() {
		var userCount int
		pod, err := scanPodValues(rows, &userCount)
		if err != nil {
			return nil, err
		}
		items = append(items, PodSummary{
			Pod:            pod,
			UserCount:      userCount,
			AvailableSlots: max(0, pod.MaxUsers-userCount),
		})
	}
	return items, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanPod(sc scanner) (Pod, error) {
	return scanPodValues(sc)
}

func scanPodValues(sc scanner, trailing ...any) (Pod, error) {
	var pod Pod
	var rotatedAt, lastAppliedAt, createdAt, updatedAt string
	dest := []any{
		&pod.PodID, &pod.DisplayName, &pod.ImageTag, &pod.State, &pod.MaxUsers,
		&pod.Channels, &pod.ChannelConfigsEnc, &pod.MemLimit, &pod.CPULimit,
		&pod.RestartPolicy, &pod.MaxSkillConcurrency,
		&pod.MaxBrowserConcurrency, &pod.ServiceTokenEnc, &pod.ServiceTokenFingerprint,
		&rotatedAt, &pod.ConfigGeneration, &pod.AppliedGeneration, &pod.LastConfigHash,
		&pod.LastApplyStatus, &pod.LastApplyError, &lastAppliedAt, &createdAt, &updatedAt,
	}
	dest = append(dest, trailing...)
	if err := sc.Scan(dest...); errors.Is(err, sql.ErrNoRows) {
		return Pod{}, ErrNotFound
	} else if err != nil {
		return Pod{}, fmt.Errorf("scan Pod: %w", err)
	}
	if err := parsePodTimes(&pod, rotatedAt, lastAppliedAt, createdAt, updatedAt); err != nil {
		return Pod{}, err
	}
	return pod, nil
}

func parsePodTimes(pod *Pod, rotatedAt, lastAppliedAt, createdAt, updatedAt string) error {
	var err error
	if pod.ServiceTokenRotatedAt, err = parseRequiredTime(rotatedAt, "service_token_rotated_at"); err != nil {
		return err
	}
	if pod.LastAppliedAt, err = parseOptionalTime(lastAppliedAt, "last_applied_at"); err != nil {
		return err
	}
	if pod.CreatedAt, err = parseRequiredTime(createdAt, "created_at"); err != nil {
		return err
	}
	if pod.UpdatedAt, err = parseRequiredTime(updatedAt, "updated_at"); err != nil {
		return err
	}
	return nil
}

func parseRequiredTime(value, field string) (time.Time, error) {
	parsed, err := time.Parse(tsLayout, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse Pod %s: %w", field, err)
	}
	return parsed, nil
}

func parseOptionalTime(value, field string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	return parseRequiredTime(value, field)
}

func formatTime(value time.Time) string {
	return value.UTC().Format(tsLayout)
}

func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return formatTime(value)
}

func isUniqueConstraint(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func affectedOrNotFound(result sql.Result, err error, action string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", action, err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s rows affected: %w", action, err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) configMutationResult(podID string, result sql.Result, err error, action string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", action, err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s rows affected: %w", action, err)
	}
	if count > 0 {
		return nil
	}
	var exists int
	err = s.db.QueryRow(`SELECT 1 FROM pods WHERE pod_id = ?`, podID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("inspect Pod generation conflict: %w", err)
	}
	return ErrGenerationConflict
}
