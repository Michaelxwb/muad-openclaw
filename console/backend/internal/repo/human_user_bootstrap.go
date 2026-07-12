package repo

import (
	"database/sql"
	"fmt"
	"time"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

type HumanUserBootstrapResult struct {
	HumanUser   HumanUser
	Identity    *UserIdentity
	BindingCode *BindingCode
	PlainCode   string
}

func (s *Store) CreateHumanUserWithIdentity(
	user HumanUser, identity UserIdentity, portStart, portEnd int,
) (HumanUserBootstrapResult, error) {
	user.Status = HumanUserStatusActive
	user, portStart, portEnd, err := prepareHumanUserCreate(user, portStart, portEnd)
	if err != nil {
		return HumanUserBootstrapResult{}, err
	}
	identity.HumanUserID, identity.PodID = user.HumanUserID, user.PodID
	if err := prepareIdentity(&identity); err != nil {
		return HumanUserBootstrapResult{}, err
	}
	if err := validateIdentity(identity); err != nil {
		return HumanUserBootstrapResult{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return HumanUserBootstrapResult{}, fmt.Errorf("begin Human User Identity bootstrap: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err = insertPreparedHumanUser(tx, user, portStart, portEnd)
	if err == nil {
		err = insertIdentity(tx, identity)
	}
	if err == nil {
		err = markPodConfigPendingTx(tx, user.PodID)
	}
	if err = commitBootstrap(tx, err, "Identity"); err != nil {
		return HumanUserBootstrapResult{}, err
	}
	return HumanUserBootstrapResult{HumanUser: user, Identity: &identity}, nil
}

func (s *Store) CreateHumanUserWithBindingCode(
	codec *secretcrypto.BindingCodeCodec, user HumanUser, request BindingCodeRequest,
	portStart, portEnd int,
) (HumanUserBootstrapResult, error) {
	if codec == nil {
		return HumanUserBootstrapResult{}, ErrInvalidBindingCode
	}
	user.Status = HumanUserStatusPending
	user, portStart, portEnd, err := prepareHumanUserCreate(user, portStart, portEnd)
	if err != nil {
		return HumanUserBootstrapResult{}, err
	}
	request.HumanUserID, request.PodID = user.HumanUserID, user.PodID
	if err := prepareBindingRequest(&request); err != nil {
		return HumanUserBootstrapResult{}, err
	}
	plain, err := codec.Generate()
	if err != nil {
		return HumanUserBootstrapResult{}, err
	}
	record, err := buildBindingCode(codec, request, plain)
	if err != nil {
		return HumanUserBootstrapResult{}, err
	}
	return s.insertHumanUserBindingBootstrap(user, record, plain, portStart, portEnd)
}

func (s *Store) insertHumanUserBindingBootstrap(
	user HumanUser, record BindingCode, plain string, portStart, portEnd int,
) (HumanUserBootstrapResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return HumanUserBootstrapResult{}, fmt.Errorf("begin Human User binding bootstrap: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err = insertPreparedHumanUser(tx, user, portStart, portEnd)
	if err == nil {
		err = insertBindingCodeRecord(tx, record)
	}
	if err == nil {
		err = markPodConfigPendingTx(tx, user.PodID)
	}
	if err = commitBootstrap(tx, err, "binding code"); err != nil {
		return HumanUserBootstrapResult{}, err
	}
	return HumanUserBootstrapResult{
		HumanUser: user, BindingCode: &record, PlainCode: plain,
	}, nil
}

func prepareHumanUserCreate(
	user HumanUser, portStart, portEnd int,
) (HumanUser, int, int, error) {
	if err := prepareNewHumanUser(&user); err != nil {
		return HumanUser{}, 0, 0, err
	}
	portStart, portEnd, err := normalizePortRange(portStart, portEnd)
	return user, portStart, portEnd, err
}

func insertPreparedHumanUser(
	tx *sql.Tx, user HumanUser, portStart, portEnd int,
) (HumanUser, error) {
	if statusConsumesCapacity(user.Status) {
		if err := ensureAvailablePodCapacity(tx, user.PodID, 1); err != nil {
			return HumanUser{}, err
		}
	} else if err := ensurePodExists(tx, user.PodID); err != nil {
		return HumanUser{}, err
	}
	port, err := allocateBrowserPort(tx, user.PodID, portStart, portEnd)
	if err != nil {
		return HumanUser{}, err
	}
	user.BrowserCDPPort = port
	if err := insertHumanUser(tx, user); err != nil {
		return HumanUser{}, err
	}
	return user, nil
}

func commitBootstrap(tx *sql.Tx, cause error, label string) error {
	if cause != nil {
		return cause
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Human User %s bootstrap: %w", label, err)
	}
	return nil
}

func (s *Store) UpdateHumanUserModelOverride(humanUserID, encrypted string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin update Human User model: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err := getHumanUserTx(tx, humanUserID)
	if err != nil {
		return err
	}
	if user.Status == HumanUserStatusDeleting {
		return ErrInvalidStateTransition
	}
	res, err := tx.Exec(`UPDATE human_users SET model_override_enc = ?, updated_at = ?
		WHERE human_user_id = ?`, encrypted, formatTime(time.Now().UTC()), humanUserID)
	if err := affectedOrNotFound(res, err, "update Human User model"); err != nil {
		return err
	}
	if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit update Human User model: %w", err)
	}
	return nil
}
