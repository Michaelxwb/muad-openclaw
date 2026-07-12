// Package runtimeapply validates and atomically applies one Pod Runtime DTO.
package runtimeapply

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
)

const transactionScript = "/opt/muad/runtime-config-transaction.mjs"

type RestartMode string

const (
	RestartNone    RestartMode = "none"
	RestartGateway RestartMode = "gateway"
	RestartPod     RestartMode = "pod"
)

type Stage string

const (
	StagePrepare  Stage = "prepare"
	StageValidate Stage = "validate"
	StageCommit   Stage = "commit"
	StageRestart  Stage = "restart"
	StageHealth   Stage = "health"
)

type Driver interface {
	Exec(ctx context.Context, podID string, cmd ...string) (string, error)
	ExecStdin(ctx context.Context, podID string, stdin io.Reader, cmd ...string) (string, error)
	Restart(ctx context.Context, podID string) error
}

type Options struct {
	HealthTimeout time.Duration
	PollInterval  time.Duration
}

type Request struct {
	PodID           string
	Generation      int64
	RuntimeJSON     []byte
	ForcePodRestart bool
}

type Result struct {
	ConfigHash  string
	RestartMode RestartMode
}

type ApplyError struct {
	Stage         Stage
	Cause         error
	RecoveryError error
}

func (e *ApplyError) Error() string {
	message := fmt.Sprintf("runtime apply %s failed: %v", e.Stage, e.Cause)
	if e.RecoveryError != nil {
		message += fmt.Sprintf("; recovery failed: %v", e.RecoveryError)
	}
	return message
}

func (e *ApplyError) Unwrap() error { return e.Cause }

type Applier struct {
	driver  Driver
	options Options
}

type prepareResult struct {
	Generation  int64       `json:"generation"`
	ConfigHash  string      `json:"configHash"`
	RestartMode RestartMode `json:"restartMode"`
}

type rollbackResult struct {
	Generation int64 `json:"generation"`
}

func New(driver Driver, options Options) (*Applier, error) {
	if driver == nil {
		return nil, errors.New("runtimeapply: driver is required")
	}
	if options.HealthTimeout <= 0 {
		options.HealthTimeout = 2 * time.Minute
	}
	if options.PollInterval <= 0 {
		options.PollInterval = 500 * time.Millisecond
	}
	return &Applier{driver: driver, options: options}, nil
}

func (applier *Applier) Apply(ctx context.Context, request Request) (Result, error) {
	if err := validateRequest(request); err != nil {
		return Result{}, &ApplyError{Stage: StagePrepare, Cause: err}
	}
	prepared, err := applier.prepare(ctx, request)
	if err != nil {
		return Result{}, &ApplyError{Stage: StagePrepare, Cause: err}
	}
	mode := prepared.RestartMode
	if request.ForcePodRestart {
		mode = RestartPod
	}
	if err := applier.validate(ctx, request.PodID); err != nil {
		return Result{}, applier.abortFailure(ctx, request.PodID, StageValidate, err)
	}
	if err := applier.commit(ctx, request); err != nil {
		return Result{}, applier.recoverFailure(ctx, request.PodID, mode, StageCommit, err)
	}
	if err := applier.restart(ctx, request.PodID, mode); err != nil {
		return Result{}, applier.recoverFailure(ctx, request.PodID, mode, StageRestart, err)
	}
	if err := applier.waitForHealth(ctx, request.PodID, request.Generation); err != nil {
		return Result{}, applier.recoverFailure(ctx, request.PodID, mode, StageHealth, err)
	}
	return Result{ConfigHash: prepared.ConfigHash, RestartMode: mode}, nil
}

func validateRequest(request Request) error {
	if strings.TrimSpace(request.PodID) == "" || request.Generation <= 0 || len(request.RuntimeJSON) == 0 {
		return errors.New("Pod ID, generation and Runtime DTO are required")
	}
	var header struct {
		PodID      string `json:"podId"`
		Generation int64  `json:"generation"`
	}
	if err := json.Unmarshal(request.RuntimeJSON, &header); err != nil {
		return fmt.Errorf("decode Runtime DTO: %w", err)
	}
	if header.PodID != request.PodID || header.Generation != request.Generation {
		return errors.New("Runtime DTO does not match requested Pod generation")
	}
	return nil
}

func (applier *Applier) prepare(ctx context.Context, request Request) (prepareResult, error) {
	output, err := applier.transactionInput(ctx, request.PodID, "prepare", request.RuntimeJSON)
	if err != nil {
		return prepareResult{}, err
	}
	var result prepareResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return prepareResult{}, fmt.Errorf("decode prepare result: %w", err)
	}
	if result.Generation != request.Generation || result.ConfigHash == "" || !validRestartMode(result.RestartMode) {
		return prepareResult{}, errors.New("invalid prepare result")
	}
	return result, nil
}

func (applier *Applier) validate(ctx context.Context, podID string) error {
	_, err := applier.transaction(ctx, podID, "validate")
	return err
}

func (applier *Applier) commit(ctx context.Context, request Request) error {
	_, err := applier.transactionInput(ctx, request.PodID, "commit", request.RuntimeJSON)
	return err
}

func (applier *Applier) restart(ctx context.Context, podID string, mode RestartMode) error {
	switch mode {
	case RestartNone:
		return nil
	case RestartPod:
		return applier.driver.Restart(ctx, podID)
	case RestartGateway:
		// Worker images run the Gateway in the foreground as PID 1; the CLI restart
		// command only targets a systemd service and is a no-op inside containers.
		_, err := applier.driver.Exec(ctx, podID, "kill", "-USR1", "1")
		return err
	default:
		return fmt.Errorf("unsupported restart mode: %s", mode)
	}
}

func (applier *Applier) waitForHealth(ctx context.Context, podID string, generation int64) error {
	probeCtx, cancel := context.WithTimeout(ctx, applier.options.HealthTimeout)
	defer cancel()
	var last gateway.Status
	for {
		last = gateway.Probe(probeCtx, applier.driver, podID)
		if last.Healthy && last.RuntimeGuardHealthy && (generation == 0 || last.RuntimeGeneration == generation) {
			return nil
		}
		timer := time.NewTimer(applier.options.PollInterval)
		select {
		case <-probeCtx.Done():
			timer.Stop()
			return fmt.Errorf("generation %d health timeout (gateway=%t guard=%t observed=%d): %w",
				generation, last.Healthy, last.RuntimeGuardHealthy, last.RuntimeGeneration, probeCtx.Err())
		case <-timer.C:
		}
	}
}

func (applier *Applier) abortFailure(ctx context.Context, podID string, stage Stage, cause error) *ApplyError {
	_, cleanupErr := applier.transaction(ctx, podID, "abort")
	return &ApplyError{Stage: stage, Cause: cause, RecoveryError: cleanupErr}
}

func (applier *Applier) recoverFailure(
	ctx context.Context, podID string, mode RestartMode, stage Stage, cause error,
) *ApplyError {
	recoveryErr := applier.rollback(ctx, podID, mode)
	return &ApplyError{Stage: stage, Cause: cause, RecoveryError: recoveryErr}
}

func (applier *Applier) rollback(ctx context.Context, podID string, mode RestartMode) error {
	output, err := applier.transaction(ctx, podID, "rollback")
	if err != nil {
		return err
	}
	var result rollbackResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return fmt.Errorf("decode rollback result: %w", err)
	}
	if mode == RestartNone {
		mode = RestartGateway
	}
	if err := applier.restart(ctx, podID, mode); err != nil {
		return fmt.Errorf("restart restored config: %w", err)
	}
	if err := applier.waitForHealth(ctx, podID, result.Generation); err != nil {
		return fmt.Errorf("verify restored config: %w", err)
	}
	return nil
}

func (applier *Applier) transaction(ctx context.Context, podID, mode string) (string, error) {
	return applier.driver.Exec(ctx, podID, "node", transactionScript, mode)
}

func (applier *Applier) transactionInput(
	ctx context.Context, podID, mode string, input []byte,
) (string, error) {
	return applier.driver.ExecStdin(ctx, podID, bytes.NewReader(input), "node", transactionScript, mode)
}

func validRestartMode(mode RestartMode) bool {
	return mode == RestartNone || mode == RestartGateway || mode == RestartPod
}
