package repo

import "time"

// Pod lifecycle states persisted by the control plane.
const (
	PodStateCreating  = "creating"
	PodStateRunning   = "running"
	PodStateStopped   = "stopped"
	PodStateUnhealthy = "unhealthy"
	PodStateError     = "error"
	PodStateDeleting  = "deleting"
)

// Pod configuration apply states.
const (
	ApplyStatusPending  = "pending"
	ApplyStatusApplying = "applying"
	ApplyStatusApplied  = "applied"
	ApplyStatusFailed   = "failed"
)

// Human User lifecycle states.
const (
	HumanUserStatusPending  = "pending"
	HumanUserStatusActive   = "active"
	HumanUserStatusDisabled = "disabled"
	HumanUserStatusDeleting = "deleting"
)

// Skill scopes describe where a Skill is sourced from.
const (
	SkillScopeSystem  = "system"
	SkillScopePublic  = "public"
	SkillScopePrivate = "private"
)

// Skill asset states persisted by the control plane.
const (
	SkillStatusActive   = "active"
	SkillStatusDisabled = "disabled"
	SkillStatusDeleted  = "deleted"
)

// Skill policy actions are scoped to one Human User in the first version.
const (
	SkillPolicyDisable       = "disable"
	SkillPolicyAllowOverride = "allow_override"
)

// Skill execution lifecycle states.
const (
	SkillExecutionRunning   = "running"
	SkillExecutionSucceeded = "succeeded"
	SkillExecutionFailed    = "failed"
	SkillExecutionCancelled = "cancelled"
)

// Effective Skill view states used by the Human User resolver.
const (
	EffectiveSkillStatusEffective         = "effective"
	EffectiveSkillStatusConflict          = "conflict"
	EffectiveSkillStatusDisabled          = "disabled"
	EffectiveSkillStatusMissingCredential = "missing_credential"
)

// Skill platform credential states are safe to expose to administrators.
const (
	SkillCredentialConfigured       = "configured"
	SkillCredentialMissing          = "missing"
	SkillCredentialPlatformDisabled = "platform_disabled"
	SkillCredentialPlatformMissing  = "platform_missing"
)

// Identity and binding-code states.
const (
	IdentityStatusActive   = "active"
	IdentityStatusDisabled = "disabled"

	BindingCodeStatusPending = "pending"
	BindingCodeStatusUsed    = "used"
	BindingCodeStatusExpired = "expired"
	BindingCodeStatusRevoked = "revoked"
)

// Binding-code purposes distinguish initial activation from adding an IM.
const (
	BindingPurposeFirstIdentity = "create_user_first_identity"
	BindingPurposeAddIdentity   = "add_identity_to_existing_user"
)

// Pod is one runtime workload that contains multiple Human Users.
type Pod struct {
	PodID                   string
	DisplayName             string
	ImageTag                string
	State                   string
	MaxUsers                int
	Channels                string
	ChannelConfigsEnc       string
	MemLimit                string
	CPULimit                string
	RestartPolicy           string
	MaxSkillConcurrency     int
	MaxBrowserConcurrency   int
	ServiceTokenEnc         string
	ServiceTokenFingerprint string
	ServiceTokenRotatedAt   time.Time
	ConfigGeneration        int64
	AppliedGeneration       int64
	LastConfigHash          string
	LastApplyStatus         string
	LastApplyError          string
	LastAppliedAt           time.Time
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

// HumanUser is a natural person hosted by a Pod.
type HumanUser struct {
	HumanUserID            string
	PodID                  string
	ModelConfigID          string
	DisplayName            string
	AgentID                string
	BrowserProfile         string
	BrowserCDPPort         int
	Status                 string
	PlatformCredentialsEnc string
	Notes                  string
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

// LLMModelConfig is one assignable model credential. A non-empty APIKeyEnc is
// encrypted at rest and exposed only through the fingerprint.
type LLMModelConfig struct {
	ModelConfigID      string
	DisplayName        string
	Provider           string
	BaseURL            string
	APIKeyEnc          string
	APIKeyFingerprint  string
	Model              string
	BoundHumanUserID   string
	BoundHumanUserName string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// UserIdentity maps one channel-scoped sender to a Human User.
type UserIdentity struct {
	IdentityID      string
	HumanUserID     string
	PodID           string
	Channel         string
	OpenClawChannel string
	AccountID       string
	ExternalID      string
	ExternalIDType  string
	PeerKind        string
	Status          string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// BindingCode stores only a keyed hash and a non-sensitive hint.
type BindingCode struct {
	BindingCodeID   string
	CodeHash        string
	CodeHint        string
	HumanUserID     string
	PodID           string
	Channel         string
	OpenClawChannel string
	AccountID       string
	Purpose         string
	Status          string
	FailedAttempts  int
	ExpiresAt       time.Time
	UsedAt          time.Time
	UsedExternalID  string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// PlatformConfig is a lightweight, adapter-owned platform definition.
type PlatformConfig struct {
	Platform    string
	DisplayName string
	ConfigEnc   string
	Enabled     bool
	UpdatedAt   time.Time
}

// SkillAsset is metadata for a system, public, or Human User private Skill.
type SkillAsset struct {
	SkillID           string
	Name              string
	Scope             string
	HumanUserID       string
	PodID             string
	DisplayName       string
	Version           string
	Status            string
	SourcePath        string
	ManifestHash      string
	ManifestJSON      string
	EntryType         string
	PlatformsJSON     string
	BrowserRequired   bool
	ProgressSupported bool
	SystemProtected   bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// SkillPolicy allows or denies one Skill for one Human User.
type SkillPolicy struct {
	PolicyID    string
	HumanUserID string
	SkillName   string
	Action      string
	Reason      string
	CreatedBy   string
	ExpiresAt   time.Time
	CreatedAt   time.Time
}

// SkillExecutionRecord stores a redacted, queryable Skill execution summary.
type SkillExecutionRecord struct {
	ExecutionID   string
	PodID         string
	HumanUserID   string
	AgentID       string
	SkillName     string
	SkillScope    string
	SkillVersion  string
	Status        string
	StartedAt     time.Time
	EndedAt       time.Time
	DurationMS    int64
	ProgressJSON  string
	ErrorCode     string
	ErrorMessage  string
	InputSummary  string
	OutputSummary string
	CreatedAt     time.Time
}

// EffectiveSkill is the final per-Human User Skill state after merging assets,
// policies, platform credentials, and recent execution state.
type EffectiveSkill struct {
	Name              string
	DisplayName       string
	Effective         bool
	EffectiveSource   string
	Status            string
	Version           string
	EntryType         string
	SystemSkillID     string
	PublicSkillID     string
	PrivateSkillID    string
	Conflict          bool
	ConflictReason    string
	Platforms         []SkillPlatformStatus
	ProgressSupported bool
	BrowserRequired   bool
	RuntimePending    bool
	LastExecution     *SkillExecutionRecord
}

// SkillPlatformStatus reports whether one Skill dependency is usable for a user.
type SkillPlatformStatus struct {
	Platform         string
	CredentialStatus string
	PlatformEnabled  bool
}

// ResourceConfig holds global or Pod-level resource limits.
type ResourceConfig struct {
	MemLimit      string
	CPULimit      string
	RestartPolicy string
	UpdatedAt     time.Time
}

// AuditEntry is one audit record with an already-redacted payload.
type AuditEntry struct {
	ID      int64     `json:"id"`
	Actor   string    `json:"actor"`
	Action  string    `json:"action"`
	Target  string    `json:"target"`
	Payload string    `json:"payload"`
	TS      time.Time `json:"ts"`
}

type AuditFilter struct {
	Actor         string
	Action        string
	Target        string
	PodID         string
	HumanUserID   string
	IdentityID    string
	BindingCodeID string
	From          time.Time
	To            time.Time
	Offset        int
	Limit         int
}

type AuditActionCount struct {
	Action string
	PodID  string
	Count  int
}

// Admin is an administrator account.
type Admin struct {
	Username     string
	PasswordHash string
}
