package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrSkillExists  = errors.New("repo: Skill already exists")
	ErrInvalidSkill = errors.New("repo: invalid Skill")

	skillNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
)

const skillAssetColumns = `skill_id, name, scope, COALESCE(human_user_id, ''),
	COALESCE(pod_id, ''), display_name, version, status, source_path,
	manifest_hash, manifest_json, entry_type, platforms_json, browser_required,
	progress_supported, system_protected, created_at, updated_at`

const skillPolicyColumns = `policy_id, human_user_id, skill_name, action, reason,
	created_by, expires_at, created_at`

const skillExecutionColumns = `execution_id, pod_id, human_user_id, agent_id,
	skill_name, skill_scope, skill_version, status, started_at, ended_at,
	duration_ms, progress_json, error_code, error_message, input_summary,
	output_summary, created_at`

// SkillAssetListFilter controls Skill asset pagination.
type SkillAssetListFilter struct {
	Offset      int
	Limit       int
	Query       string
	Scope       string
	Status      string
	HumanUserID string
	PodID       string
}

// SkillExecutionListFilter controls execution-record pagination.
type SkillExecutionListFilter struct {
	Offset      int
	Limit       int
	PodID       string
	HumanUserID string
	AgentID     string
	SkillName   string
	Status      string
	From        time.Time
	To          time.Time
}

// CreateSkillAsset inserts one Skill metadata row.
func (s *Store) CreateSkillAsset(asset SkillAsset) (SkillAsset, error) {
	prepared, err := prepareSkillAsset(asset)
	if err != nil {
		return SkillAsset{}, err
	}
	err = insertSkillAsset(s.db, prepared)
	if isUniqueConstraint(err) {
		return SkillAsset{}, ErrSkillExists
	}
	if err != nil {
		return SkillAsset{}, err
	}
	return prepared, nil
}

// CreatePrivateSkillAssetAndMarkPod inserts private Skill metadata and marks
// the owning Pod pending in one transaction.
func (s *Store) CreatePrivateSkillAssetAndMarkPod(asset SkillAsset) (SkillAsset, error) {
	prepared, err := prepareSkillAsset(asset)
	if err != nil {
		return SkillAsset{}, err
	}
	if prepared.Scope != SkillScopePrivate {
		return SkillAsset{}, ErrInvalidSkill
	}
	tx, err := s.db.Begin()
	if err != nil {
		return SkillAsset{}, fmt.Errorf("begin create private Skill asset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := ensurePodExists(tx, prepared.PodID); err != nil {
		return SkillAsset{}, err
	}
	if _, err := getHumanUserTx(tx, prepared.HumanUserID); err != nil {
		return SkillAsset{}, err
	}
	if err := insertSkillAssetTx(tx, prepared); isUniqueConstraint(err) {
		return SkillAsset{}, ErrSkillExists
	} else if err != nil {
		return SkillAsset{}, err
	}
	if err := markPodConfigPendingTx(tx, prepared.PodID); err != nil {
		return SkillAsset{}, err
	}
	if err := tx.Commit(); err != nil {
		return SkillAsset{}, fmt.Errorf("commit create private Skill asset: %w", err)
	}
	return prepared, nil
}

// UpsertPublicSkillAssetAndMarkPods creates or updates public Skill metadata
// and marks every Pod pending so running runtimes can reload the shared asset.
func (s *Store) UpsertPublicSkillAssetAndMarkPods(asset SkillAsset) (SkillAsset, []string, error) {
	prepared, err := prepareSkillAsset(asset)
	if err != nil {
		return SkillAsset{}, nil, err
	}
	if prepared.Scope != SkillScopePublic {
		return SkillAsset{}, nil, ErrInvalidSkill
	}
	tx, err := s.db.Begin()
	if err != nil {
		return SkillAsset{}, nil, fmt.Errorf("begin upsert public Skill asset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	existing, err := getActiveGlobalSkillByNameTx(tx, prepared.Name)
	switch {
	case errors.Is(err, ErrNotFound):
		if err := insertSkillAssetTx(tx, prepared); isUniqueConstraint(err) {
			return SkillAsset{}, nil, ErrSkillExists
		} else if err != nil {
			return SkillAsset{}, nil, err
		}
	case err != nil:
		return SkillAsset{}, nil, err
	case existing.Scope == SkillScopeSystem:
		return SkillAsset{}, nil, ErrInvalidSkill
	default:
		prepared.SkillID = existing.SkillID
		prepared.CreatedAt = existing.CreatedAt
		prepared.SystemProtected = false
		if err := updatePublicSkillAssetTx(tx, prepared); err != nil {
			return SkillAsset{}, nil, err
		}
	}
	podIDs, err := markAllPodsConfigPendingTx(tx)
	if err != nil {
		return SkillAsset{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return SkillAsset{}, nil, fmt.Errorf("commit upsert public Skill asset: %w", err)
	}
	return prepared, podIDs, nil
}

// GetSkillAsset returns one Skill asset or ErrNotFound.
func (s *Store) GetSkillAsset(skillID string) (SkillAsset, error) {
	row := s.db.QueryRow(`SELECT `+skillAssetColumns+`
		FROM skill_assets WHERE skill_id = ?`, strings.TrimSpace(skillID))
	return scanSkillAsset(row)
}

// ListSkillAssetsByName returns non-deleted assets for an exact Skill name.
func (s *Store) ListSkillAssetsByName(name string) ([]SkillAsset, error) {
	rows, err := s.db.Query(`SELECT `+skillAssetColumns+`
		FROM skill_assets WHERE name = ? AND status != 'deleted'
		ORDER BY scope, human_user_id`, strings.TrimSpace(name))
	if err != nil {
		return nil, fmt.Errorf("list Skill assets by name: %w", err)
	}
	defer rows.Close()
	return collectSkillAssets(rows)
}

// ListSkillAssets returns a filtered page of Skill assets.
func (s *Store) ListSkillAssets(filter SkillAssetListFilter) ([]SkillAsset, int, error) {
	where, args := skillAssetWhere(filter)
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM skill_assets`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count Skill assets: %w", err)
	}
	query := `SELECT ` + skillAssetColumns + ` FROM skill_assets` + where +
		` ORDER BY scope, name, human_user_id`
	listArgs := append([]any(nil), args...)
	if filter.Limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		listArgs = append(listArgs, filter.Limit, filter.Offset)
	}
	rows, err := s.db.Query(query, listArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list Skill assets: %w", err)
	}
	defer rows.Close()
	assets, err := collectSkillAssets(rows)
	return assets, total, err
}

// UpdateSkillAssetStatus updates one Skill asset state.
func (s *Store) UpdateSkillAssetStatus(skillID, status string) error {
	if !validSkillAssetStatus(status) {
		return ErrInvalidSkill
	}
	res, err := s.db.Exec(`UPDATE skill_assets SET status = ?, updated_at = ?
		WHERE skill_id = ?`, status, formatTime(time.Now().UTC()), strings.TrimSpace(skillID))
	return affectedOrNotFound(res, err, "update Skill asset status")
}

// DeleteSkillAsset marks one Skill asset as deleted.
func (s *Store) DeleteSkillAsset(skillID string) error {
	return s.UpdateSkillAssetStatus(skillID, SkillStatusDeleted)
}

// DeletePrivateSkillAssetAndMarkPod marks private Skill metadata deleted and
// marks the owning Pod pending.
func (s *Store) DeletePrivateSkillAssetAndMarkPod(skillID, humanUserID string) (SkillAsset, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return SkillAsset{}, fmt.Errorf("begin delete private Skill asset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	asset, err := getSkillAssetTx(tx, skillID)
	if err != nil {
		return SkillAsset{}, err
	}
	if asset.Scope != SkillScopePrivate || asset.HumanUserID != strings.TrimSpace(humanUserID) {
		return SkillAsset{}, ErrNotFound
	}
	result, err := tx.Exec(`UPDATE skill_assets SET status = 'deleted',
		updated_at = ? WHERE skill_id = ?`, formatTime(time.Now().UTC()), asset.SkillID)
	if err := affectedOrNotFound(result, err, "delete private Skill asset"); err != nil {
		return SkillAsset{}, err
	}
	if err := markPodConfigPendingTx(tx, asset.PodID); err != nil {
		return SkillAsset{}, err
	}
	if err := tx.Commit(); err != nil {
		return SkillAsset{}, fmt.Errorf("commit delete private Skill asset: %w", err)
	}
	asset.Status = SkillStatusDeleted
	return asset, nil
}

// UpdateSkillAssetStatusAndMarkPods updates status and marks affected Pods pending.
func (s *Store) UpdateSkillAssetStatusAndMarkPods(
	skillID, status string,
) (SkillAsset, []string, error) {
	if !validSkillAssetStatus(status) {
		return SkillAsset{}, nil, ErrInvalidSkill
	}
	tx, err := s.db.Begin()
	if err != nil {
		return SkillAsset{}, nil, fmt.Errorf("begin update Skill asset status: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	asset, err := getSkillAssetTx(tx, skillID)
	if err != nil {
		return SkillAsset{}, nil, err
	}
	if asset.SystemProtected && status != SkillStatusActive {
		return SkillAsset{}, nil, ErrInvalidSkill
	}
	if !validSkillAssetStatusTransition(asset, status) {
		return SkillAsset{}, nil, ErrInvalidSkill
	}
	result, err := tx.Exec(`UPDATE skill_assets SET status = ?, updated_at = ?
		WHERE skill_id = ?`, status, formatTime(time.Now().UTC()), strings.TrimSpace(skillID))
	if err := affectedOrNotFound(result, err, "update Skill asset status"); err != nil {
		return SkillAsset{}, nil, err
	}
	asset.Status = status
	asset.UpdatedAt = time.Now().UTC()
	podIDs, err := markSkillAssetPodsPendingTx(tx, asset)
	if err != nil {
		return SkillAsset{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return SkillAsset{}, nil, fmt.Errorf("commit update Skill asset status: %w", err)
	}
	return asset, podIDs, nil
}

// CreateSkillPolicy inserts a Human User scoped Skill policy.
func (s *Store) CreateSkillPolicy(policy SkillPolicy) (SkillPolicy, error) {
	prepared, err := prepareSkillPolicy(policy)
	if err != nil {
		return SkillPolicy{}, err
	}
	return prepared, insertSkillPolicy(s.db, prepared)
}

// CreateSkillPolicyAndMarkPod inserts a policy and marks its user's Pod pending.
func (s *Store) CreateSkillPolicyAndMarkPod(policy SkillPolicy) (SkillPolicy, string, error) {
	prepared, err := prepareSkillPolicy(policy)
	if err != nil {
		return SkillPolicy{}, "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return SkillPolicy{}, "", fmt.Errorf("begin create Skill policy: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err := getHumanUserTx(tx, prepared.HumanUserID)
	if err != nil {
		return SkillPolicy{}, "", err
	}
	if err := insertSkillPolicy(tx, prepared); err != nil {
		return SkillPolicy{}, "", err
	}
	if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
		return SkillPolicy{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return SkillPolicy{}, "", fmt.Errorf("commit create Skill policy: %w", err)
	}
	return prepared, user.PodID, nil
}

// ListSkillPoliciesByHumanUser returns all policies for one Human User.
func (s *Store) ListSkillPoliciesByHumanUser(humanUserID string) ([]SkillPolicy, error) {
	rows, err := s.db.Query(`SELECT `+skillPolicyColumns+`
		FROM skill_policies WHERE human_user_id = ? ORDER BY skill_name, action`,
		strings.TrimSpace(humanUserID))
	if err != nil {
		return nil, fmt.Errorf("list Skill policies: %w", err)
	}
	defer rows.Close()
	return collectSkillPolicies(rows)
}

// DeleteSkillPolicy removes one policy row.
func (s *Store) DeleteSkillPolicy(policyID string) error {
	res, err := s.db.Exec(`DELETE FROM skill_policies WHERE policy_id = ?`, strings.TrimSpace(policyID))
	return affectedOrNotFound(res, err, "delete Skill policy")
}

// DeleteSkillPolicyForHumanUserAndMarkPod deletes a policy scoped to one user
// and marks that user's Pod pending.
func (s *Store) DeleteSkillPolicyForHumanUserAndMarkPod(policyID, humanUserID string) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", fmt.Errorf("begin delete Skill policy: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	policy, err := getSkillPolicyTx(tx, policyID)
	if err != nil {
		return "", err
	}
	if policy.HumanUserID != strings.TrimSpace(humanUserID) {
		return "", ErrNotFound
	}
	user, err := getHumanUserTx(tx, policy.HumanUserID)
	if err != nil {
		return "", err
	}
	res, err := tx.Exec(`DELETE FROM skill_policies WHERE policy_id = ?`, strings.TrimSpace(policyID))
	if err := affectedOrNotFound(res, err, "delete Skill policy"); err != nil {
		return "", err
	}
	if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit delete Skill policy: %w", err)
	}
	return user.PodID, nil
}

// UpsertSkillExecutionRecord inserts or updates one redacted execution summary.
func (s *Store) UpsertSkillExecutionRecord(record SkillExecutionRecord) (SkillExecutionRecord, error) {
	prepared, err := prepareSkillExecutionRecord(record)
	if err != nil {
		return SkillExecutionRecord{}, err
	}
	_, err = s.db.Exec(`INSERT INTO skill_execution_records (
		execution_id, pod_id, human_user_id, agent_id, skill_name, skill_scope,
		skill_version, status, started_at, ended_at, duration_ms, progress_json,
		error_code, error_message, input_summary, output_summary, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(execution_id) DO UPDATE SET
		status=excluded.status, ended_at=excluded.ended_at,
		duration_ms=excluded.duration_ms, progress_json=excluded.progress_json,
		error_code=excluded.error_code, error_message=excluded.error_message,
		input_summary=excluded.input_summary, output_summary=excluded.output_summary`,
		prepared.ExecutionID, prepared.PodID, prepared.HumanUserID, prepared.AgentID,
		prepared.SkillName, prepared.SkillScope, prepared.SkillVersion, prepared.Status,
		formatTime(prepared.StartedAt), formatOptionalTime(prepared.EndedAt),
		prepared.DurationMS, prepared.ProgressJSON, prepared.ErrorCode, prepared.ErrorMessage,
		prepared.InputSummary, prepared.OutputSummary, formatTime(prepared.CreatedAt))
	if err != nil {
		return SkillExecutionRecord{}, fmt.Errorf("upsert Skill execution: %w", err)
	}
	return prepared, nil
}

// ListSkillExecutionRecords returns a filtered page of execution records.
func (s *Store) ListSkillExecutionRecords(
	filter SkillExecutionListFilter,
) ([]SkillExecutionRecord, int, error) {
	where, args := skillExecutionWhere(filter)
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM skill_execution_records`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count Skill executions: %w", err)
	}
	query := `SELECT ` + skillExecutionColumns + ` FROM skill_execution_records` +
		where + ` ORDER BY started_at DESC, execution_id DESC`
	listArgs := append([]any(nil), args...)
	if filter.Limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		listArgs = append(listArgs, filter.Limit, filter.Offset)
	}
	rows, err := s.db.Query(query, listArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list Skill executions: %w", err)
	}
	defer rows.Close()
	records, err := collectSkillExecutionRecords(rows)
	return records, total, err
}

func prepareSkillAsset(asset SkillAsset) (SkillAsset, error) {
	asset.Name = strings.TrimSpace(asset.Name)
	asset.DisplayName = strings.TrimSpace(asset.DisplayName)
	asset.Scope = strings.TrimSpace(asset.Scope)
	if asset.DisplayName == "" {
		asset.DisplayName = asset.Name
	}
	if asset.Status == "" {
		asset.Status = SkillStatusActive
	}
	if asset.EntryType == "" {
		asset.EntryType = "script"
	}
	if asset.ManifestJSON == "" {
		asset.ManifestJSON = "{}"
	}
	if asset.PlatformsJSON == "" {
		asset.PlatformsJSON = "[]"
	}
	if err := validateSkillAsset(asset); err != nil {
		return SkillAsset{}, err
	}
	return fillSkillAssetDefaults(asset)
}

func validateSkillAsset(asset SkillAsset) error {
	if !validSkillName(asset.Name) || !validSkillScope(asset.Scope) ||
		!validSkillAssetStatus(asset.Status) || strings.TrimSpace(asset.SourcePath) == "" ||
		strings.TrimSpace(asset.ManifestHash) == "" || !json.Valid([]byte(asset.ManifestJSON)) ||
		!json.Valid([]byte(asset.PlatformsJSON)) {
		return ErrInvalidSkill
	}
	if asset.Scope == SkillScopePrivate {
		if strings.TrimSpace(asset.HumanUserID) == "" || strings.TrimSpace(asset.PodID) == "" {
			return ErrInvalidSkill
		}
		return nil
	}
	if strings.TrimSpace(asset.HumanUserID) != "" || strings.TrimSpace(asset.PodID) != "" {
		return ErrInvalidSkill
	}
	return nil
}

func fillSkillAssetDefaults(asset SkillAsset) (SkillAsset, error) {
	if asset.SkillID == "" {
		id, err := generateUUIDv4()
		if err != nil {
			return SkillAsset{}, fmt.Errorf("generate Skill ID: %w", err)
		}
		asset.SkillID = id
	}
	if asset.Scope == SkillScopeSystem {
		asset.SystemProtected = true
	}
	now := time.Now().UTC()
	asset.CreatedAt = now
	asset.UpdatedAt = now
	return asset, nil
}

func prepareSkillPolicy(policy SkillPolicy) (SkillPolicy, error) {
	policy.HumanUserID = strings.TrimSpace(policy.HumanUserID)
	policy.SkillName = strings.TrimSpace(policy.SkillName)
	policy.Action = strings.TrimSpace(policy.Action)
	policy.CreatedBy = strings.TrimSpace(policy.CreatedBy)
	if !validSkillName(policy.SkillName) || policy.HumanUserID == "" ||
		!validSkillPolicyAction(policy.Action) || policy.CreatedBy == "" {
		return SkillPolicy{}, ErrInvalidSkill
	}
	if policy.PolicyID == "" {
		id, err := generateUUIDv4()
		if err != nil {
			return SkillPolicy{}, fmt.Errorf("generate Skill policy ID: %w", err)
		}
		policy.PolicyID = id
	}
	policy.CreatedAt = time.Now().UTC()
	return policy, nil
}

func prepareSkillExecutionRecord(
	record SkillExecutionRecord,
) (SkillExecutionRecord, error) {
	record.PodID = strings.TrimSpace(record.PodID)
	record.HumanUserID = strings.TrimSpace(record.HumanUserID)
	record.AgentID = strings.TrimSpace(record.AgentID)
	record.SkillName = strings.TrimSpace(record.SkillName)
	record.SkillScope = strings.TrimSpace(record.SkillScope)
	if record.Status == "" {
		record.Status = SkillExecutionRunning
	}
	if record.ProgressJSON == "" {
		record.ProgressJSON = "[]"
	}
	if err := validateSkillExecutionRecord(record); err != nil {
		return SkillExecutionRecord{}, err
	}
	return fillSkillExecutionDefaults(record)
}

func validateSkillExecutionRecord(record SkillExecutionRecord) error {
	if record.PodID == "" || record.HumanUserID == "" || record.AgentID == "" ||
		!validSkillName(record.SkillName) || !validSkillScope(record.SkillScope) ||
		!validSkillExecutionStatus(record.Status) || !json.Valid([]byte(record.ProgressJSON)) {
		return ErrInvalidSkill
	}
	return nil
}

func fillSkillExecutionDefaults(
	record SkillExecutionRecord,
) (SkillExecutionRecord, error) {
	if record.ExecutionID == "" {
		id, err := generateUUIDv4()
		if err != nil {
			return SkillExecutionRecord{}, fmt.Errorf("generate Skill execution ID: %w", err)
		}
		record.ExecutionID = id
	}
	now := time.Now().UTC()
	if record.StartedAt.IsZero() {
		record.StartedAt = now
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = now
	}
	return record, nil
}

func insertSkillAsset(db *sql.DB, asset SkillAsset) error {
	return insertSkillAssetTx(db, asset)
}

func insertSkillAssetTx(db interface {
	Exec(query string, args ...any) (sql.Result, error)
}, asset SkillAsset) error {
	_, err := db.Exec(`INSERT INTO skill_assets (
		skill_id, name, scope, human_user_id, pod_id, display_name, version,
		status, source_path, manifest_hash, manifest_json, entry_type, platforms_json,
		browser_required, progress_supported, system_protected, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		asset.SkillID, asset.Name, asset.Scope, nullIfEmpty(asset.HumanUserID),
		nullIfEmpty(asset.PodID), asset.DisplayName, asset.Version, asset.Status,
		asset.SourcePath, asset.ManifestHash, asset.ManifestJSON, asset.EntryType,
		asset.PlatformsJSON, boolToInt(asset.BrowserRequired), boolToInt(asset.ProgressSupported),
		boolToInt(asset.SystemProtected), formatTime(asset.CreatedAt), formatTime(asset.UpdatedAt))
	if err != nil {
		return fmt.Errorf("insert Skill asset: %w", err)
	}
	return nil
}

func getSkillAssetTx(tx *sql.Tx, skillID string) (SkillAsset, error) {
	row := tx.QueryRow(`SELECT `+skillAssetColumns+`
		FROM skill_assets WHERE skill_id = ?`, strings.TrimSpace(skillID))
	return scanSkillAsset(row)
}

func getActiveGlobalSkillByNameTx(tx *sql.Tx, name string) (SkillAsset, error) {
	row := tx.QueryRow(`SELECT `+skillAssetColumns+`
		FROM skill_assets
		WHERE name = ? AND scope IN ('system', 'public') AND status != 'deleted'
		ORDER BY CASE scope WHEN 'system' THEN 0 ELSE 1 END
		LIMIT 1`, strings.TrimSpace(name))
	return scanSkillAsset(row)
}

func updatePublicSkillAssetTx(tx *sql.Tx, asset SkillAsset) error {
	result, err := tx.Exec(`UPDATE skill_assets SET
		display_name = ?, version = ?, status = 'active', source_path = ?,
		manifest_hash = ?, manifest_json = ?, entry_type = ?, platforms_json = ?,
		browser_required = ?, progress_supported = ?, system_protected = 0,
		updated_at = ?
		WHERE skill_id = ? AND scope = 'public'`,
		asset.DisplayName, asset.Version, asset.SourcePath, asset.ManifestHash,
		asset.ManifestJSON, asset.EntryType, asset.PlatformsJSON,
		boolToInt(asset.BrowserRequired), boolToInt(asset.ProgressSupported),
		formatTime(asset.UpdatedAt), asset.SkillID)
	return affectedOrNotFound(result, err, "update public Skill asset")
}

func insertSkillPolicy(db interface {
	Exec(query string, args ...any) (sql.Result, error)
}, policy SkillPolicy) error {
	_, err := db.Exec(`INSERT INTO skill_policies (
		policy_id, human_user_id, skill_name, action, reason,
		created_by, expires_at, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, policy.PolicyID, policy.HumanUserID,
		policy.SkillName, policy.Action, policy.Reason, policy.CreatedBy,
		formatOptionalTime(policy.ExpiresAt), formatTime(policy.CreatedAt))
	if err != nil {
		return fmt.Errorf("insert Skill policy: %w", err)
	}
	return nil
}

func getSkillPolicyTx(tx *sql.Tx, policyID string) (SkillPolicy, error) {
	row := tx.QueryRow(`SELECT `+skillPolicyColumns+`
		FROM skill_policies WHERE policy_id = ?`, strings.TrimSpace(policyID))
	return scanSkillPolicy(row)
}

func markSkillAssetPodsPendingTx(tx *sql.Tx, asset SkillAsset) ([]string, error) {
	if asset.Scope == SkillScopePrivate {
		if err := markPodConfigPendingTx(tx, asset.PodID); err != nil {
			return nil, err
		}
		return []string{asset.PodID}, nil
	}
	return markAllPodsConfigPendingTx(tx)
}

func skillAssetWhere(filter SkillAssetListFilter) (string, []any) {
	clauses := make([]string, 0, 6)
	args := make([]any, 0, 8)
	for _, item := range []struct{ clause, value string }{
		{"scope = ?", filter.Scope},
		{"human_user_id = ?", filter.HumanUserID}, {"pod_id = ?", filter.PodID},
	} {
		if strings.TrimSpace(item.value) != "" {
			clauses = append(clauses, item.clause)
			args = append(args, strings.TrimSpace(item.value))
		}
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		clauses = append(clauses, "status = ?")
		args = append(args, status)
	} else {
		clauses = append(clauses, "status IN (?, ?)")
		args = append(args, SkillStatusActive, SkillStatusDisabled)
	}
	if query := strings.TrimSpace(filter.Query); query != "" {
		clauses = append(clauses, "(name LIKE ? OR display_name LIKE ?)")
		pattern := "%" + query + "%"
		args = append(args, pattern, pattern)
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func skillExecutionWhere(filter SkillExecutionListFilter) (string, []any) {
	clauses := make([]string, 0, 7)
	args := make([]any, 0, 8)
	for _, item := range []struct{ clause, value string }{
		{"pod_id = ?", filter.PodID}, {"human_user_id = ?", filter.HumanUserID},
		{"agent_id = ?", filter.AgentID}, {"skill_name = ?", filter.SkillName},
		{"status = ?", filter.Status},
	} {
		if strings.TrimSpace(item.value) != "" {
			clauses = append(clauses, item.clause)
			args = append(args, strings.TrimSpace(item.value))
		}
	}
	if !filter.From.IsZero() {
		clauses = append(clauses, "started_at >= ?")
		args = append(args, formatTime(filter.From))
	}
	if !filter.To.IsZero() {
		clauses = append(clauses, "started_at <= ?")
		args = append(args, formatTime(filter.To))
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func collectSkillAssets(rows *sql.Rows) ([]SkillAsset, error) {
	assets := []SkillAsset{}
	for rows.Next() {
		asset, err := scanSkillAsset(rows)
		if err != nil {
			return nil, err
		}
		assets = append(assets, asset)
	}
	return assets, rows.Err()
}

func collectSkillPolicies(rows *sql.Rows) ([]SkillPolicy, error) {
	policies := []SkillPolicy{}
	for rows.Next() {
		policy, err := scanSkillPolicy(rows)
		if err != nil {
			return nil, err
		}
		policies = append(policies, policy)
	}
	return policies, rows.Err()
}

func collectSkillExecutionRecords(rows *sql.Rows) ([]SkillExecutionRecord, error) {
	records := []SkillExecutionRecord{}
	for rows.Next() {
		record, err := scanSkillExecutionRecord(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func scanSkillAsset(sc scanner) (SkillAsset, error) {
	var asset SkillAsset
	var browserRequired, progressSupported, systemProtected int
	var createdAt, updatedAt string
	err := sc.Scan(&asset.SkillID, &asset.Name, &asset.Scope, &asset.HumanUserID,
		&asset.PodID, &asset.DisplayName, &asset.Version, &asset.Status, &asset.SourcePath,
		&asset.ManifestHash, &asset.ManifestJSON, &asset.EntryType, &asset.PlatformsJSON,
		&browserRequired, &progressSupported, &systemProtected, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SkillAsset{}, ErrNotFound
	}
	if err != nil {
		return SkillAsset{}, fmt.Errorf("scan Skill asset: %w", err)
	}
	return parseSkillAsset(asset, browserRequired, progressSupported, systemProtected, createdAt, updatedAt)
}

func parseSkillAsset(
	asset SkillAsset, browserRequired, progressSupported, systemProtected int,
	createdAt, updatedAt string,
) (SkillAsset, error) {
	var err error
	asset.BrowserRequired = browserRequired == 1
	asset.ProgressSupported = progressSupported == 1
	asset.SystemProtected = systemProtected == 1
	asset.CreatedAt, err = parseRequiredTime(createdAt, "skill_assets.created_at")
	if err != nil {
		return SkillAsset{}, err
	}
	asset.UpdatedAt, err = parseRequiredTime(updatedAt, "skill_assets.updated_at")
	if err != nil {
		return SkillAsset{}, err
	}
	return asset, nil
}

func scanSkillPolicy(sc scanner) (SkillPolicy, error) {
	var policy SkillPolicy
	var expiresAt, createdAt string
	err := sc.Scan(&policy.PolicyID, &policy.HumanUserID, &policy.SkillName,
		&policy.Action, &policy.Reason, &policy.CreatedBy, &expiresAt, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SkillPolicy{}, ErrNotFound
	}
	if err != nil {
		return SkillPolicy{}, fmt.Errorf("scan Skill policy: %w", err)
	}
	var parseErr error
	policy.ExpiresAt, parseErr = parseOptionalTime(expiresAt, "skill_policies.expires_at")
	if parseErr != nil {
		return SkillPolicy{}, parseErr
	}
	policy.CreatedAt, parseErr = parseRequiredTime(createdAt, "skill_policies.created_at")
	if parseErr != nil {
		return SkillPolicy{}, parseErr
	}
	return policy, nil
}

func scanSkillExecutionRecord(sc scanner) (SkillExecutionRecord, error) {
	var record SkillExecutionRecord
	var startedAt, endedAt, createdAt string
	err := sc.Scan(&record.ExecutionID, &record.PodID, &record.HumanUserID,
		&record.AgentID, &record.SkillName, &record.SkillScope, &record.SkillVersion,
		&record.Status, &startedAt, &endedAt, &record.DurationMS, &record.ProgressJSON,
		&record.ErrorCode, &record.ErrorMessage, &record.InputSummary,
		&record.OutputSummary, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SkillExecutionRecord{}, ErrNotFound
	}
	if err != nil {
		return SkillExecutionRecord{}, fmt.Errorf("scan Skill execution: %w", err)
	}
	return parseSkillExecutionRecord(record, startedAt, endedAt, createdAt)
}

func parseSkillExecutionRecord(
	record SkillExecutionRecord, startedAt, endedAt, createdAt string,
) (SkillExecutionRecord, error) {
	var err error
	record.StartedAt, err = parseRequiredTime(startedAt, "skill_execution_records.started_at")
	if err != nil {
		return SkillExecutionRecord{}, err
	}
	record.EndedAt, err = parseOptionalTime(endedAt, "skill_execution_records.ended_at")
	if err != nil {
		return SkillExecutionRecord{}, err
	}
	record.CreatedAt, err = parseRequiredTime(createdAt, "skill_execution_records.created_at")
	if err != nil {
		return SkillExecutionRecord{}, err
	}
	return record, nil
}

func validSkillName(name string) bool {
	return skillNamePattern.MatchString(name)
}

func validSkillScope(scope string) bool {
	switch scope {
	case SkillScopeSystem, SkillScopePublic, SkillScopePrivate:
		return true
	default:
		return false
	}
}

func validSkillAssetStatus(status string) bool {
	switch status {
	case SkillStatusActive, SkillStatusDisabled, SkillStatusDeleted:
		return true
	default:
		return false
	}
}

func validSkillAssetStatusTransition(asset SkillAsset, next string) bool {
	if asset.Status == SkillStatusDeleted {
		return false
	}
	if next == SkillStatusDeleted && asset.Scope == SkillScopePrivate {
		return false
	}
	return next == SkillStatusActive || next == SkillStatusDisabled || next == SkillStatusDeleted
}

func validSkillPolicyAction(action string) bool {
	switch action {
	case SkillPolicyDisable, SkillPolicyAllowOverride:
		return true
	default:
		return false
	}
}

func validSkillExecutionStatus(status string) bool {
	switch status {
	case SkillExecutionRunning, SkillExecutionSucceeded, SkillExecutionFailed, SkillExecutionCancelled:
		return true
	default:
		return false
	}
}
