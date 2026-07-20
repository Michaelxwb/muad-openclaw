package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

const (
	defaultBindingCodeTTL  = 30 * time.Minute
	maximumBindingCodeTTL  = 24 * time.Hour
	maximumBindingFailures = 5
)

var (
	ErrInvalidBindingCode = errors.New("repo: invalid binding code")
	ErrBindingCodeExpired = errors.New("repo: binding code expired")
	ErrBindingCodeUsed    = errors.New("repo: binding code already used")
	ErrBindingCodeRevoked = errors.New("repo: binding code revoked")
	ErrBindingCodeScope   = errors.New("repo: binding code context mismatch")
)

const bindingCodeColumns = `binding_code_id, code_hash, code_hint,
	human_user_id, pod_id, channel, openclaw_channel, account_id, purpose,
	status, failed_attempts, expires_at, used_at, used_external_id,
	created_at, updated_at`

// BindingCodeRequest defines the administrator-selected activation scope.
type BindingCodeRequest struct {
	HumanUserID     string
	PodID           string
	Channel         string
	OpenClawChannel string
	AccountID       string
	Purpose         string
	ExpiresAt       time.Time
}

// BindingActivation is built from trusted Runtime Guard message context.
type BindingActivation struct {
	Code            string
	PodID           string
	Channel         string
	OpenClawChannel string
	AccountID       string
	ExternalID      string
	ExternalIDType  string
	PeerKind        string
}

// BindingActivationResult describes the committed identity and new generation.
type BindingActivationResult struct {
	Identity         UserIdentity
	HumanUser        HumanUser
	ConfigGeneration int64
}

// CreateBindingCode creates one code whose plaintext is returned exactly once.
func (s *Store) CreateBindingCode(
	codec *secretcrypto.BindingCodeCodec, request BindingCodeRequest,
) (BindingCode, string, error) {
	if codec == nil {
		return BindingCode{}, "", ErrInvalidBindingCode
	}
	if err := prepareBindingRequest(&request); err != nil {
		return BindingCode{}, "", err
	}
	plain, err := codec.Generate()
	if err != nil {
		return BindingCode{}, "", err
	}
	record, err := buildBindingCode(codec, request, plain)
	if err != nil {
		return BindingCode{}, "", err
	}
	if err := s.insertBindingCode(record); err != nil {
		return BindingCode{}, "", err
	}
	return record, plain, nil
}

// GetBindingCode returns one internal record or ErrNotFound.
func (s *Store) GetBindingCode(bindingCodeID string) (BindingCode, error) {
	row := s.db.QueryRow(`SELECT `+bindingCodeColumns+`
		FROM binding_codes WHERE binding_code_id = ?`, bindingCodeID)
	return scanBindingCode(row)
}

// ListBindingCodesByHumanUser returns records without plaintext codes.
func (s *Store) ListBindingCodesByHumanUser(humanUserID string) ([]BindingCode, error) {
	rows, err := s.db.Query(`SELECT `+bindingCodeColumns+` FROM binding_codes
		WHERE human_user_id = ? ORDER BY created_at DESC`, humanUserID)
	if err != nil {
		return nil, fmt.Errorf("list binding codes: %w", err)
	}
	defer rows.Close()
	var codes []BindingCode
	for rows.Next() {
		code, err := scanBindingCode(rows)
		if err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, rows.Err()
}

// RevokeBindingCode revokes a pending code.
func (s *Store) RevokeBindingCode(bindingCodeID string) error {
	res, err := s.db.Exec(`UPDATE binding_codes SET status = 'revoked',
		updated_at = ? WHERE binding_code_id = ? AND status = 'pending'`,
		formatTime(time.Now().UTC()), bindingCodeID)
	if err != nil {
		return fmt.Errorf("revoke binding code: %w", err)
	}
	return bindingCodeMutationMiss(s, bindingCodeID, res)
}

// ExpireBindingCodes expires all pending records at or before now.
func (s *Store) ExpireBindingCodes(now time.Time) (int64, error) {
	res, err := s.db.Exec(`UPDATE binding_codes SET status = 'expired', updated_at = ?
		WHERE status = 'pending' AND expires_at <= ?`, formatTime(now), formatTime(now))
	if err != nil {
		return 0, fmt.Errorf("expire binding codes: %w", err)
	}
	count, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("expire binding codes rows affected: %w", err)
	}
	return count, nil
}

// ActivateBindingCode atomically creates an Identity and consumes the code.
func (s *Store) ActivateBindingCode(
	codec *secretcrypto.BindingCodeCodec, activation BindingActivation, now time.Time,
) (BindingActivationResult, error) {
	if codec == nil {
		return BindingActivationResult{}, ErrInvalidBindingCode
	}
	hash, err := codec.Hash(activation.Code)
	if err != nil {
		return BindingActivationResult{}, ErrInvalidBindingCode
	}
	tx, err := s.db.Begin()
	if err != nil {
		return BindingActivationResult{}, fmt.Errorf("begin activate binding code: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	record, err := findBindingCodeByHashTx(tx, hash)
	if err != nil {
		return BindingActivationResult{}, err
	}
	if err := validateBindingStateTx(tx, record, now); err != nil {
		return BindingActivationResult{}, err
	}
	if !bindingScopeMatches(record, activation) {
		if err := persistBindingFailure(tx, record, now); err != nil {
			return BindingActivationResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return BindingActivationResult{}, fmt.Errorf("commit binding failure: %w", err)
		}
		return BindingActivationResult{}, ErrBindingCodeScope
	}
	return activateBindingTx(tx, record, activation, now)
}

func prepareBindingRequest(request *BindingCodeRequest) error {
	if request.AccountID == "" {
		request.AccountID = "default"
	}
	values := []string{
		request.HumanUserID, request.PodID, request.Channel,
		request.OpenClawChannel, request.AccountID,
	}
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return ErrInvalidBindingCode
		}
	}
	if request.Purpose != BindingPurposeFirstIdentity && request.Purpose != BindingPurposeAddIdentity {
		return ErrInvalidBindingCode
	}
	now := time.Now().UTC()
	if request.ExpiresAt.IsZero() {
		request.ExpiresAt = now.Add(defaultBindingCodeTTL)
	}
	if !request.ExpiresAt.After(now) || request.ExpiresAt.After(now.Add(maximumBindingCodeTTL)) {
		return ErrInvalidBindingCode
	}
	return nil
}

func buildBindingCode(
	codec *secretcrypto.BindingCodeCodec, request BindingCodeRequest, plain string,
) (BindingCode, error) {
	id, err := generateUUIDv4()
	if err != nil {
		return BindingCode{}, fmt.Errorf("generate binding code ID: %w", err)
	}
	hash, err := codec.Hash(plain)
	if err != nil {
		return BindingCode{}, err
	}
	hint, err := secretcrypto.BindingCodeHint(plain)
	if err != nil {
		return BindingCode{}, err
	}
	now := time.Now().UTC()
	return BindingCode{
		BindingCodeID: id, CodeHash: hash, CodeHint: hint,
		HumanUserID: request.HumanUserID, PodID: request.PodID,
		Channel: request.Channel, OpenClawChannel: request.OpenClawChannel,
		AccountID: request.AccountID, Purpose: request.Purpose,
		Status: BindingCodeStatusPending, ExpiresAt: request.ExpiresAt.UTC(),
		CreatedAt: now, UpdatedAt: now,
	}, nil
}

func (s *Store) insertBindingCode(record BindingCode) error {
	user, err := s.GetHumanUser(record.HumanUserID)
	if err != nil {
		return err
	}
	if user.PodID != record.PodID || user.Status == HumanUserStatusDisabled || user.Status == HumanUserStatusDeleting {
		return ErrInvalidStateTransition
	}
	return insertBindingCodeRecord(s.db, record)
}

type statementExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func insertBindingCodeRecord(execer statementExecer, record BindingCode) error {
	_, err := execer.Exec(`INSERT INTO binding_codes (
		binding_code_id, code_hash, code_hint, human_user_id, pod_id, channel,
		openclaw_channel, account_id, purpose, status, failed_attempts, expires_at,
		used_at, used_external_id, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.BindingCodeID, record.CodeHash, record.CodeHint, record.HumanUserID,
		record.PodID, record.Channel, record.OpenClawChannel, record.AccountID,
		record.Purpose, record.Status, record.FailedAttempts, formatTime(record.ExpiresAt),
		"", record.UsedExternalID, formatTime(record.CreatedAt), formatTime(record.UpdatedAt))
	if isUniqueConstraint(err) {
		return ErrInvalidBindingCode
	}
	if err != nil {
		return fmt.Errorf("insert binding code: %w", err)
	}
	return nil
}

func findBindingCodeByHashTx(tx *sql.Tx, hash string) (BindingCode, error) {
	row := tx.QueryRow(`SELECT `+bindingCodeColumns+`
		FROM binding_codes WHERE code_hash = ?`, hash)
	record, err := scanBindingCode(row)
	if errors.Is(err, ErrNotFound) {
		return BindingCode{}, ErrInvalidBindingCode
	}
	return record, err
}

func validateBindingStateTx(tx *sql.Tx, record BindingCode, now time.Time) error {
	if record.Status == BindingCodeStatusUsed {
		return ErrBindingCodeUsed
	}
	if record.Status == BindingCodeStatusRevoked {
		return ErrBindingCodeRevoked
	}
	if record.Status == BindingCodeStatusExpired {
		return ErrBindingCodeExpired
	}
	if !record.ExpiresAt.After(now) {
		if _, err := tx.Exec(`UPDATE binding_codes SET status = 'expired',
			updated_at = ? WHERE binding_code_id = ?`, formatTime(now), record.BindingCodeID); err != nil {
			return fmt.Errorf("mark binding code expired: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit binding code expiry: %w", err)
		}
		return ErrBindingCodeExpired
	}
	return nil
}

func bindingScopeMatches(record BindingCode, activation BindingActivation) bool {
	return record.PodID == activation.PodID &&
		record.Channel == activation.Channel &&
		record.OpenClawChannel == activation.OpenClawChannel &&
		record.AccountID == activation.AccountID &&
		strings.TrimSpace(activation.ExternalID) != "" &&
		strings.TrimSpace(activation.ExternalIDType) != "" &&
		activation.PeerKind == "direct"
}

func persistBindingFailure(tx *sql.Tx, record BindingCode, now time.Time) error {
	nextAttempts := record.FailedAttempts + 1
	nextStatus := BindingCodeStatusPending
	if nextAttempts >= maximumBindingFailures {
		nextStatus = BindingCodeStatusRevoked
	}
	_, err := tx.Exec(`UPDATE binding_codes SET failed_attempts = ?, status = ?,
		updated_at = ? WHERE binding_code_id = ?`, nextAttempts, nextStatus,
		formatTime(now), record.BindingCodeID)
	if err != nil {
		return fmt.Errorf("record binding-code failure: %w", err)
	}
	return nil
}

func activateBindingTx(
	tx *sql.Tx, record BindingCode, activation BindingActivation, now time.Time,
) (BindingActivationResult, error) {
	user, err := getHumanUserTx(tx, record.HumanUserID)
	if err != nil {
		return BindingActivationResult{}, err
	}
	if user.PodID != record.PodID || user.Status == HumanUserStatusDisabled || user.Status == HumanUserStatusDeleting {
		return BindingActivationResult{}, ErrInvalidStateTransition
	}
	// Enforce purpose against user state (first-identity vs add-identity).
	switch record.Purpose {
	case BindingPurposeFirstIdentity:
		if user.Status != HumanUserStatusPending {
			return BindingActivationResult{}, ErrInvalidStateTransition
		}
	case BindingPurposeAddIdentity:
		if user.Status != HumanUserStatusActive {
			return BindingActivationResult{}, ErrInvalidStateTransition
		}
	}
	identity, err := bindingIdentity(record, activation, now)
	if err != nil {
		return BindingActivationResult{}, err
	}
	if err := insertIdentity(tx, identity); err != nil {
		return BindingActivationResult{}, err
	}
	if user.Status == HumanUserStatusPending {
		if err := setHumanUserStatusTx(tx, user.HumanUserID, HumanUserStatusActive); err != nil {
			return BindingActivationResult{}, err
		}
		user.Status = HumanUserStatusActive
	}
	if err := consumeBindingCodeTx(tx, record.BindingCodeID, activation.ExternalID, now); err != nil {
		return BindingActivationResult{}, err
	}
	generation, err := incrementPodGenerationTx(tx, record.PodID, now)
	if err != nil {
		return BindingActivationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return BindingActivationResult{}, fmt.Errorf("commit binding activation: %w", err)
	}
	return BindingActivationResult{
		Identity: identity, HumanUser: user, ConfigGeneration: generation,
	}, nil
}

func bindingIdentity(
	record BindingCode, activation BindingActivation, now time.Time,
) (UserIdentity, error) {
	id, err := generateUUIDv4()
	if err != nil {
		return UserIdentity{}, fmt.Errorf("generate Identity ID: %w", err)
	}
	return UserIdentity{
		IdentityID: id, HumanUserID: record.HumanUserID, PodID: record.PodID,
		Channel: record.Channel, OpenClawChannel: record.OpenClawChannel,
		AccountID: record.AccountID, ExternalID: activation.ExternalID,
		ExternalIDType: activation.ExternalIDType, PeerKind: activation.PeerKind,
		Status: IdentityStatusActive, CreatedAt: now, UpdatedAt: now,
	}, nil
}

func consumeBindingCodeTx(tx *sql.Tx, bindingCodeID, externalID string, now time.Time) error {
	res, err := tx.Exec(`UPDATE binding_codes SET status = 'used', used_at = ?,
		used_external_id = ?, updated_at = ? WHERE binding_code_id = ? AND status = 'pending'`,
		formatTime(now), externalID, formatTime(now), bindingCodeID)
	return affectedOrNotFound(res, err, "consume binding code")
}

func incrementPodGenerationTx(tx *sql.Tx, podID string, now time.Time) (int64, error) {
	row := tx.QueryRow(`UPDATE pods SET config_generation = config_generation + 1,
		last_apply_status = 'pending', last_apply_error = '', updated_at = ?
		WHERE pod_id = ? RETURNING config_generation`, formatTime(now), podID)
	var generation int64
	if err := row.Scan(&generation); errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	} else if err != nil {
		return 0, fmt.Errorf("increment Pod config generation: %w", err)
	}
	return generation, nil
}

func bindingCodeMutationMiss(s *Store, bindingCodeID string, result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("binding code rows affected: %w", err)
	}
	if count > 0 {
		return nil
	}
	record, err := s.GetBindingCode(bindingCodeID)
	if errors.Is(err, ErrNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	switch record.Status {
	case BindingCodeStatusUsed:
		return ErrBindingCodeUsed
	case BindingCodeStatusExpired:
		return ErrBindingCodeExpired
	case BindingCodeStatusRevoked:
		return ErrBindingCodeRevoked
	default:
		return ErrInvalidBindingCode
	}
}

func scanBindingCode(sc scanner) (BindingCode, error) {
	var record BindingCode
	var expiresAt, usedAt, createdAt, updatedAt string
	err := sc.Scan(&record.BindingCodeID, &record.CodeHash, &record.CodeHint,
		&record.HumanUserID, &record.PodID, &record.Channel, &record.OpenClawChannel,
		&record.AccountID, &record.Purpose, &record.Status, &record.FailedAttempts,
		&expiresAt, &usedAt, &record.UsedExternalID, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return BindingCode{}, ErrNotFound
	}
	if err != nil {
		return BindingCode{}, fmt.Errorf("scan binding code: %w", err)
	}
	if err := parseBindingCodeTimes(&record, expiresAt, usedAt, createdAt, updatedAt); err != nil {
		return BindingCode{}, err
	}
	return record, nil
}

func parseBindingCodeTimes(
	record *BindingCode, expiresAt, usedAt, createdAt, updatedAt string,
) error {
	var err error
	if record.ExpiresAt, err = parseRequiredTime(expiresAt, "binding_codes.expires_at"); err != nil {
		return err
	}
	if record.UsedAt, err = parseOptionalTime(usedAt, "binding_codes.used_at"); err != nil {
		return err
	}
	if record.CreatedAt, err = parseRequiredTime(createdAt, "binding_codes.created_at"); err != nil {
		return err
	}
	if record.UpdatedAt, err = parseRequiredTime(updatedAt, "binding_codes.updated_at"); err != nil {
		return err
	}
	return nil
}
