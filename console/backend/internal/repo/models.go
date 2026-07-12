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
	LLMOverrideEnc          string
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
	DisplayName            string
	AgentID                string
	BrowserProfile         string
	BrowserCDPPort         int
	Status                 string
	ModelOverrideEnc       string
	PlatformCredentialsEnc string
	Notes                  string
	CreatedAt              time.Time
	UpdatedAt              time.Time
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

// ResourceConfig holds global or Pod-level resource limits.
type ResourceConfig struct {
	MemLimit      string
	CPULimit      string
	RestartPolicy string
	UpdatedAt     time.Time
}

// LLMGlobal is the single-row global LLM default. APIKeyEnc holds ciphertext.
type LLMGlobal struct {
	Provider  string
	BaseURL   string
	APIKeyEnc string
	Model     string
	UpdatedAt time.Time
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
