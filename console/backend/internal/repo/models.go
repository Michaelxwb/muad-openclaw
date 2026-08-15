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
	SkillStatusPending  = "pending"
	SkillStatusDeleted  = "deleted"
)

// Skill asset sources: user-authored (skill-upload/ingest) vs platform/admin.
const (
	SkillSourceUser     = "user"
	SkillSourcePlatform = "platform"
)

// Skill policy actions are scoped to one Human User in the first version.
const (
	SkillPolicyDisable       = "disable"
	SkillPolicyAllowOverride = "allow_override"
)

// Long task queue lifecycle states. These intentionally do not extend
// SkillExecution statuses; queued/running task state is operational, not audit.
const (
	LongTaskQueued    = "queued"
	LongTaskRunning   = "running"
	LongTaskSucceeded = "succeeded"
	LongTaskFailed    = "failed"
)

// Skill entry types distinguish managed bundles from traditional OpenClaw Skills.
const (
	SkillEntryManaged           = "managed"
	SkillEntryTraditionalScript = "traditional-script"
	SkillEntryTraditionalPrompt = "traditional-prompt"
)

// Skill activation modes describe how one execution was attributed.
const (
	SkillActivationTool         = "tool"
	SkillActivationPathDetected = "path-detected"
	SkillActivationRunner       = "runner"
)

// Effective Skill view states used by the Human User resolver.
const (
	EffectiveSkillStatusEffective         = "effective"
	EffectiveSkillStatusPending           = "pending"
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
	MaxLongTaskConcurrency  int
	ServiceTokenEnc         string
	ServiceTokenFingerprint string
	ServiceTokenRotatedAt   time.Time
	ConfigGeneration        int64
	AppliedGeneration       int64
	SkillsPending           bool
	LastConfigHash          string
	LastApplyStatus         string
	LastApplyError          string
	LastAppliedAt           time.Time
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

// HumanUser is a natural person hosted by a Pod. PodID is empty while the
// user is unbound (its Pod was deleted); LastPodID remembers the most recent
// Pod for one-click restore on recreate.
type HumanUser struct {
	HumanUserID    string
	PodID          string
	ModelConfigID  string
	DisplayName    string
	AgentID        string
	BrowserProfile string
	BrowserCDPPort int
	Status         string
	Notes          string
	LastPodID      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// LLMModelConfig is one assignable model credential stored with its plaintext
// API key plus the latest connectivity-test outcome.
type LLMModelConfig struct {
	ModelConfigID      string
	DisplayName        string
	Provider           string
	BaseURL            string
	APIKey             string
	Model              string
	LastTestAt         time.Time
	LastTestOK         bool
	LastTestError      string
	SupportsTools      bool
	BoundHumanUserID   string
	BoundHumanUserName string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// UserIdentity maps one channel-scoped sender to a Human User. The owning
// Pod is derived from HumanUser.PodID; identities are user-owned and survive
// Pod deletion.
type UserIdentity struct {
	IdentityID      string
	HumanUserID     string
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
	Enabled     bool
	UpdatedAt   time.Time
}

// SkillAsset is metadata for a system, public, or Human User private Skill.
// Private Skills follow the owning Human User; their Pod is derived from
// HumanUser.PodID (no pod_id column).
type SkillAsset struct {
	SkillID           string
	Name              string
	Scope             string
	HumanUserID       string
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
	Source            string
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

// SkillExecutionRecord stores the minimal who-when-what Skill audit row.
type SkillExecutionRecord struct {
	ExecutionID string
	PodID       string
	HumanUserID string
	AgentID     string
	SkillName   string
	SkillScope  string
	StartedAt   time.Time
	CreatedAt   time.Time
}

// LongTaskTask mirrors the runtime guard background-task queue for operator
// visibility. The Console is the only database writer; Skill execution audit
// remains in skill_execution_records.
type LongTaskTask struct {
	TaskID         string
	PodID          string
	HumanUserID    string
	PoolKey        string
	PoolQueued     int
	PoolRunning    int
	PoolLimit      int
	AgentID        string
	PeerID         string
	SkillName      string
	SkillRoot      string
	Status         string
	SubmittedAt    time.Time
	StartedAt      time.Time
	EndedAt        time.Time
	TerminalReason string
	ErrorCode      string
	UpdatedAt      time.Time
	LastSeenAt     time.Time
}

// LongTaskPool summarizes one user-agent runtime queue.
type LongTaskPool struct {
	PodID       string
	HumanUserID string
	PoolKey     string
	PoolQueued  int
	PoolRunning int
	PoolLimit   int
	AgentID     string
	PeerID      string
	UpdatedAt   time.Time
	LastSeenAt  time.Time
}

// LongTaskListFilter controls long-task queue pagination and filtering.
type LongTaskListFilter struct {
	Offset      int
	Limit       int
	Query       string
	PodID       string
	HumanUserID string
	AgentID     string
	SkillName   string
	PoolKey     string
	Status      string
}

// EffectiveSkill is the final per-Human User Skill state after merging assets,
// policies, platform credentials, and recent execution state.
type EffectiveSkill struct {
	Name              string
	DisplayName       string
	Effective         bool
	EffectiveSource   string
	Source            string
	Status            string
	Version           string
	EntryType         string
	ScriptFiles       []string
	SystemSkillID     string
	PublicSkillID     string
	PrivateSkillID    string
	Conflict          bool
	ConflictReason    string
	Platforms         []SkillPlatformStatus
	ProgressSupported bool
	BrowserRequired   bool
	LongTask          bool
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
	MemLimit               string
	CPULimit               string
	RestartPolicy          string
	MaxSkillConcurrency    int
	MaxBrowserConcurrency  int
	MaxLongTaskConcurrency int
	UpdatedAt              time.Time
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
