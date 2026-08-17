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
	"sync"
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

	// validatedHashes caches the last successfully validated config hash per
	// Pod. Validating runs `openclaw config validate` + a skill-tree scan inside
	// the Pod (~0.7s+ of openclaw CLI overhead); re-applying an identical config
	// (apply-config, reconcile retries) can safely skip it because the candidate
	// was already proven loadable.
	mu              sync.Mutex
	validatedHashes map[string]string
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
	expectedRoutes, err := expectedDirectRoutes(request.RuntimeJSON)
	if err != nil {
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
	if err := applier.validate(ctx, request.PodID, prepared.ConfigHash); err != nil {
		return Result{}, applier.abortFailure(ctx, request.PodID, StageValidate, err)
	}
	if err := applier.commit(ctx, request); err != nil {
		return Result{}, applier.recoverFailure(ctx, request.PodID, mode, StageCommit, err)
	}
	if err := applier.restart(ctx, request.PodID, mode); err != nil {
		return Result{}, applier.recoverFailure(ctx, request.PodID, mode, StageRestart, err)
	}
	if err := applier.waitForHealth(ctx, request.PodID, request.Generation, mode, expectedRoutes); err != nil {
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

// validate verifies the staged candidate config is loadable inside the Pod.
// Re-applying a config hash that already passed validation is skipped: the
// candidate was proven loadable before, and the expensive openclaw CLI calls
// (~0.7s+ each) are pure overhead on apply-config / reconcile retries.
func (applier *Applier) validate(ctx context.Context, podID, configHash string) error {
	applier.mu.Lock()
	if applier.validatedHashes != nil && applier.validatedHashes[podID] == configHash {
		applier.mu.Unlock()
		return nil
	}
	applier.mu.Unlock()
	if _, err := applier.transaction(ctx, podID, "validate"); err != nil {
		return err
	}
	applier.mu.Lock()
	if applier.validatedHashes == nil {
		applier.validatedHashes = make(map[string]string)
	}
	applier.validatedHashes[podID] = configHash
	applier.mu.Unlock()
	return nil
}

func (applier *Applier) commit(ctx context.Context, request Request) error {
	_, err := applier.transactionInput(ctx, request.PodID, "commit", request.RuntimeJSON)
	return err
}

func (applier *Applier) restart(ctx context.Context, podID string, mode RestartMode) error {
	switch mode {
	case RestartNone:
		// 可热加载变更（agents/skills/plugins 等）由 openclaw hybrid watcher
		// 分层热加载（~150ms）生效，无需重启 gateway；waitForHealth 通过
		// config revision 是否 applied 门禁收敛。
		return nil
	case RestartGateway:
		// bindings / session.identityLinks 变更不在 openclaw hybrid watcher 的
		// 热加载列表（reload 分类为 noop），channel 插件启动时快照配置对象，
		// 运行中不会重新读取新 bindings。必须真实重启 gateway（worker 镜像里
		// gateway 是 PID 1，CLI restart 命令只面向 systemd 服务，容器内无效），
		// 让插件重新捕获配置，否则绑定后的消息仍按旧路由落入 main agent。
		_, err := applier.driver.Exec(ctx, podID, "kill", "-USR1", "1")
		return err
	case RestartPod:
		return applier.driver.Restart(ctx, podID)
	default:
		return fmt.Errorf("unsupported restart mode: %s", mode)
	}
}

func (applier *Applier) waitForHealth(
	ctx context.Context, podID string, generation int64, mode RestartMode,
	expectedRoutes []gateway.RouteExpectation,
) error {
	requireConfigApplied := mode == RestartNone
	requireRoutes := len(expectedRoutes) > 0
	deadline := time.Now().Add(applier.options.HealthTimeout)
	extended := false
	var last gateway.Status
	for {
		last = applier.probeHealth(ctx, podID, generation, requireConfigApplied, expectedRoutes)
		if applyReady(last, generation, requireConfigApplied, requireRoutes) {
			return nil
		}
		timer := time.NewTimer(applier.options.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return applier.healthTimeoutError(last, generation, requireConfigApplied, requireRoutes, ctx.Err())
		case <-timer.C:
		}
		if time.Now().After(deadline) {
			if routeHealthExtension(last, extended) {
				// 路由验证 RPC 失败（状态未知）≠ 确定性失败：再等一个健康窗口，
				// 避免网关重启期间 verify-routes 瞬时不可用导致整体回滚。
				extended = true
				deadline = time.Now().Add(applier.options.HealthTimeout)
				continue
			}
			return applier.healthTimeoutError(last, generation, requireConfigApplied, requireRoutes,
				fmt.Errorf("health not ready within %s", applier.options.HealthTimeout))
		}
	}
}

// routeHealthExtension reports whether the health wait should extend its
// deadline once: the runtime is healthy but the route verification state is
// unknown (verification RPC failed) — an unknown state is not a deterministic
// failure, so the wait keeps polling instead of rolling back.
func routeHealthExtension(status gateway.Status, alreadyExtended bool) bool {
	return !alreadyExtended && status.Healthy && status.RouteUnknown
}

func (applier *Applier) healthTimeoutError(
	status gateway.Status, generation int64, requireConfigApplied, requireRoutes bool, cause error,
) error {
	return fmt.Errorf(
		"%s generation %d health timeout (gateway=%t guard=%t observed=%d configApplied=%t configGeneration=%d revision=%q applied=%q routeVerified=%t routeUnknown=%t routeChecked=%d routeFailed=%d routeGeneration=%d routeError=%q): %w",
		healthFailureCode(status, generation, requireConfigApplied, requireRoutes),
		generation, status.Healthy, status.RuntimeGuardHealthy, status.RuntimeGeneration,
		status.ConfigApplied, status.ConfigGeneration, status.ConfigRevisionHash, status.AppliedConfigHash,
		status.RouteVerified, status.RouteUnknown, status.RouteChecked, status.RouteFailed, status.RouteGeneration,
		status.RouteError, cause,
	)
}

func (applier *Applier) probeHealth(
	ctx context.Context, podID string, generation int64, requireConfigApplied bool,
	expectedRoutes []gateway.RouteExpectation,
) gateway.Status {
	var status gateway.Status
	if requireConfigApplied {
		status = gateway.ProbeWithConfigRevision(ctx, applier.driver, podID)
	} else {
		status = gateway.Probe(ctx, applier.driver, podID)
	}
	if runtimeReady(status, generation) && (!requireConfigApplied || status.ConfigApplied) {
		mergeRouteVerification(ctx, applier.driver, podID, generation, expectedRoutes, &status)
	}
	return status
}

func runtimeReady(status gateway.Status, generation int64) bool {
	return status.Healthy && status.RuntimeGuardHealthy &&
		(generation == 0 || status.RuntimeGeneration == generation)
}

func applyReady(
	status gateway.Status, generation int64, requireConfigApplied bool, requireRoutes bool,
) bool {
	return runtimeReady(status, generation) &&
		(!requireConfigApplied || status.ConfigApplied) &&
		// 路由验证结果必须针对当前 generation：旧 generation 的 OK 不能放行。
		(!requireRoutes || (status.RouteVerified && status.RouteGeneration == generation))
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
	if err := applier.restart(ctx, podID, mode); err != nil {
		return fmt.Errorf("restart restored config: %w", err)
	}
	if err := applier.waitForHealth(ctx, podID, result.Generation, mode, nil); err != nil {
		return fmt.Errorf("verify restored config: %w", err)
	}
	return nil
}

func mergeRouteVerification(
	ctx context.Context, ex gateway.Execer, podID string, generation int64,
	expectedRoutes []gateway.RouteExpectation, status *gateway.Status,
) {
	result, err := gateway.VerifyRoutes(ctx, ex, podID, generation, expectedRoutes)
	if err != nil {
		// RPC/解码失败：路由状态未知，不是确定性失败——健康等待继续轮询，
		// 不把瞬时不可达当成验证失败。
		status.RouteError = err.Error()
		status.RouteUnknown = true
		return
	}
	status.RouteUnknown = false
	status.RouteVerified = result.OK
	status.RouteChecked = result.Checked
	status.RouteFailed = result.Failed
	status.RouteGeneration = result.Generation
	status.RouteError = result.Error
}

func expectedDirectRoutes(raw []byte) ([]gateway.RouteExpectation, error) {
	var payload struct {
		Routes []gateway.RouteExpectation `json:"routes"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("decode runtime routes: %w", err)
	}
	return filterDirectRoutes(payload.Routes), nil
}

func filterDirectRoutes(routes []gateway.RouteExpectation) []gateway.RouteExpectation {
	expected := make([]gateway.RouteExpectation, 0, len(routes))
	for _, route := range routes {
		if route.PeerKind == "direct" || route.PeerKind == "dm" {
			expected = append(expected, route)
		}
	}
	return expected
}

func healthFailureCode(
	status gateway.Status, generation int64, requireConfigApplied bool, requireRoutes bool,
) string {
	switch {
	case !status.Healthy:
		return "L1_gateway_unreachable"
	case requireConfigApplied && !status.ConfigApplied:
		return "L3_config_not_applied"
	case !status.RuntimeGuardHealthy || status.RuntimeGeneration != generation:
		return "L4_guard_unready"
	case requireRoutes && status.RouteUnknown:
		return "L5_route_unknown"
	case requireRoutes && status.RouteVerified && status.RouteGeneration != generation:
		return "L5_route_generation_mismatch"
	case requireRoutes && !status.RouteVerified:
		return "L5_route_not_applied"
	default:
		return "health_timeout"
	}
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
