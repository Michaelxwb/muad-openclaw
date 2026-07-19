// Package audit records typed, redacted control-plane events.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// Action is a supported semantic audit event.
type Action string

const (
	ActionPodCreate                Action = "pod.create"
	ActionPodUpdate                Action = "pod.update"
	ActionPodDelete                Action = "pod.delete"
	ActionHumanUserCreate          Action = "human_user.create"
	ActionHumanUserUpdate          Action = "human_user.update"
	ActionHumanUserDelete          Action = "human_user.delete"
	ActionIdentityCreate           Action = "identity.create"
	ActionIdentityUpdate           Action = "identity.update"
	ActionIdentityDelete           Action = "identity.delete"
	ActionBindingCodeCreate        Action = "binding_code.create"
	ActionBindingCodeActivate      Action = "binding_code.activate"
	ActionBindingCodeFail          Action = "binding_code.fail"
	ActionBindingCodeRevoke        Action = "binding_code.revoke"
	ActionPlatformConfigCreate     Action = "platform_config.create"
	ActionPlatformConfigUpdate     Action = "platform_config.update"
	ActionPlatformConfigDisable    Action = "platform_config.disable"
	ActionPlatformConfigDelete     Action = "platform_config.delete"
	ActionPlatformCredentialCreate Action = "platform_credential.create"
	ActionPlatformCredentialUpdate Action = "platform_credential.update"
	ActionPlatformCredentialDelete Action = "platform_credential.delete"
	ActionSkillAssetScan           Action = "skill.asset.scan"
	ActionSkillAssetInstall        Action = "skill.asset.install"
	ActionSkillAssetUpdate         Action = "skill.asset.update"
	ActionSkillAssetDelete         Action = "skill.asset.delete"
	ActionSkillPolicyCreate        Action = "skill.policy.create"
	ActionSkillPolicyDelete        Action = "skill.policy.delete"
	ActionSessionResolveFail       Action = "session_credential.resolve_fail"
	ActionPodConfigApply           Action = "pod_config.apply"
	ActionPodConfigSuccess         Action = "pod_config.success"
	ActionPodConfigFail            Action = "pod_config.fail"
	ActionRuntimeGuardBind         Action = "runtime_guard.bind"
	ActionRuntimeGuardReject       Action = "runtime_guard.reject"
	ActionPodServiceTokenRotate    Action = "pod_service_token.rotate"
)

var validActions = map[Action]struct{}{
	ActionPodCreate: {}, ActionPodUpdate: {}, ActionPodDelete: {},
	ActionHumanUserCreate: {}, ActionHumanUserUpdate: {}, ActionHumanUserDelete: {},
	ActionIdentityCreate: {}, ActionIdentityUpdate: {}, ActionIdentityDelete: {},
	ActionBindingCodeCreate: {}, ActionBindingCodeActivate: {}, ActionBindingCodeFail: {}, ActionBindingCodeRevoke: {},
	ActionPlatformConfigCreate: {}, ActionPlatformConfigUpdate: {}, ActionPlatformConfigDisable: {},
	ActionPlatformConfigDelete:     {},
	ActionPlatformCredentialCreate: {}, ActionPlatformCredentialUpdate: {}, ActionPlatformCredentialDelete: {},
	ActionSkillAssetScan: {}, ActionSkillAssetInstall: {}, ActionSkillAssetUpdate: {},
	ActionSkillAssetDelete: {}, ActionSkillPolicyCreate: {}, ActionSkillPolicyDelete: {},
	ActionSessionResolveFail: {}, ActionPodConfigApply: {}, ActionPodConfigSuccess: {},
	ActionPodConfigFail: {}, ActionRuntimeGuardBind: {}, ActionRuntimeGuardReject: {},
	ActionPodServiceTokenRotate: {},
}

// Metadata deliberately exposes no free-form secret-bearing field.
type Metadata struct {
	PodID             string `json:"podId,omitempty"`
	HumanUserID       string `json:"humanUserId,omitempty"`
	AgentID           string `json:"agentId,omitempty"`
	IdentityID        string `json:"identityId,omitempty"`
	BindingCodeID     string `json:"bindingCodeId,omitempty"`
	Platform          string `json:"platform,omitempty"`
	SkillID           string `json:"skillId,omitempty"`
	SkillName         string `json:"skillName,omitempty"`
	Fingerprint       string `json:"fingerprint,omitempty"`
	Status            string `json:"status,omitempty"`
	ErrorCode         string `json:"errorCode,omitempty"`
	Generation        int64  `json:"generation,omitempty"`
	AppliedGeneration int64  `json:"appliedGeneration,omitempty"`
	Count             int    `json:"count,omitempty"`
}

// Event is one typed audit write.
type Event struct {
	Actor    string
	Action   Action
	Target   string
	Metadata Metadata
}

// Sink is implemented by repo.Store and fakes.
type Sink interface {
	AddAudit(repo.AuditEntry) error
}

// Record validates, serializes, and stores a semantic event.
func Record(ctx context.Context, sink Sink, event Event) error {
	if err := validateEvent(event); err != nil {
		return err
	}
	payload, err := json.Marshal(event.Metadata)
	if err != nil {
		return fmt.Errorf("marshal audit metadata: %w", err)
	}
	if err := sink.AddAudit(repo.AuditEntry{
		Actor: event.Actor, Action: string(event.Action), Target: event.Target,
		Payload: string(payload),
	}); err != nil {
		return fmt.Errorf("write semantic audit event: %w", err)
	}
	markSemantic(ctx)
	return nil
}

// AdminActor returns the authenticated administrator actor.
func AdminActor(username string) string {
	return strings.TrimSpace(username)
}

// PodActor identifies an internal runtime actor without exposing its token.
func PodActor(podID string) string {
	return "pod:" + strings.TrimSpace(podID)
}

var (
	secretAssignment = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+`)
	bearerValue      = regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/=-]+`)
	skValue          = regexp.MustCompile(`(?i)\bsk-[a-z0-9_-]{6,}\b`)
)

// RedactDiagnostic makes runtime errors safe for audit and alert responses.
func RedactDiagnostic(value string) string {
	value = RedactSensitiveText(value)
	value = strings.TrimSpace(value)
	if len(value) > 512 {
		return value[:512]
	}
	return value
}

// RedactSensitiveText removes common credential forms without truncating logs.
func RedactSensitiveText(value string) string {
	value = secretAssignment.ReplaceAllString(value, "$1=[redacted]")
	value = bearerValue.ReplaceAllString(value, "Bearer [redacted]")
	value = skValue.ReplaceAllString(value, "sk-[redacted]")
	return value
}

func validateEvent(event Event) error {
	if strings.TrimSpace(event.Actor) == "" {
		return errors.New("audit: actor is required")
	}
	if _, ok := validActions[event.Action]; !ok {
		return fmt.Errorf("audit: unsupported action %q", event.Action)
	}
	return nil
}

type trackerKey struct{}

type requestTracker struct {
	semantic atomic.Bool
}

// WithRequestTracker enables semantic-event de-duplication for one request.
func WithRequestTracker(ctx context.Context) context.Context {
	return context.WithValue(ctx, trackerKey{}, &requestTracker{})
}

// HasSemanticEvent reports whether a typed event was successfully persisted.
func HasSemanticEvent(ctx context.Context) bool {
	tracker, _ := ctx.Value(trackerKey{}).(*requestTracker)
	return tracker != nil && tracker.semantic.Load()
}

func markSemantic(ctx context.Context) {
	tracker, _ := ctx.Value(trackerKey{}).(*requestTracker)
	if tracker != nil {
		tracker.semantic.Store(true)
	}
}
