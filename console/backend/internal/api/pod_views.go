package api

import (
	"context"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type podView struct {
	PodID                   string                       `json:"podId"`
	DisplayName             string                       `json:"displayName"`
	ImageTag                string                       `json:"imageTag"`
	State                   string                       `json:"state"`
	Channels                []string                     `json:"channels"`
	ChannelConfigs          map[string]channelConfigView `json:"channelConfigs,omitempty"`
	ChannelStatuses         map[string]bool              `json:"channelStatuses,omitempty"`
	ModelOverride           modelOverrideView            `json:"modelOverride"`
	MaxUsers                int                          `json:"maxUsers"`
	UserCount               int                          `json:"userCount"`
	AvailableSlots          int                          `json:"availableSlots"`
	ConfigGeneration        int64                        `json:"configGeneration"`
	AppliedGeneration       int64                        `json:"appliedGeneration"`
	GenerationLag           int64                        `json:"generationLag"`
	LastApplyStatus         string                       `json:"lastApplyStatus"`
	LastApplyError          string                       `json:"lastApplyError,omitempty"`
	LastAppliedAt           *time.Time                   `json:"lastAppliedAt,omitempty"`
	ServiceTokenFingerprint string                       `json:"serviceTokenFingerprint"`
	CPUPercent              float64                      `json:"cpuPercent"`
	MemMiB                  int                          `json:"memMiB"`
	SkillActive             int                          `json:"skillActive"`
	SkillQueued             int                          `json:"skillQueued"`
	BrowserActive           int                          `json:"browserActive"`
	BrowserQueued           int                          `json:"browserQueued"`
	RuntimeGuardHealthy     bool                         `json:"runtimeGuardHealthy"`
	CreatedAt               time.Time                    `json:"createdAt"`
	UpdatedAt               time.Time                    `json:"updatedAt"`
}

func (s *Server) makePodView(
	summary repo.PodSummary, states map[string]string, includeCredentials bool,
) (podView, error) {
	channels, configs, err := s.decodeChannelSettings(summary.Pod)
	if err != nil {
		return podView{}, err
	}
	model, err := s.decodeModelOverride(summary.LLMOverrideEnc)
	if err != nil {
		return podView{}, err
	}
	view := podView{
		PodID: summary.PodID, DisplayName: summary.DisplayName, ImageTag: summary.ImageTag,
		State: derivePodState(summary.Pod, states), Channels: channels, ModelOverride: modelToView(model),
		MaxUsers: summary.MaxUsers, UserCount: summary.UserCount, AvailableSlots: summary.AvailableSlots,
		ConfigGeneration: summary.ConfigGeneration, AppliedGeneration: summary.AppliedGeneration,
		GenerationLag:   max(int64(0), summary.ConfigGeneration-summary.AppliedGeneration),
		LastApplyStatus: summary.LastApplyStatus, LastApplyError: auditlog.RedactDiagnostic(summary.LastApplyError),
		ServiceTokenFingerprint: crypto.DisplayFingerprint(summary.ServiceTokenFingerprint),
		CreatedAt:               summary.CreatedAt, UpdatedAt: summary.UpdatedAt,
	}
	if includeCredentials {
		view.ChannelConfigs = channelConfigViews(channels, configs)
	}
	if !summary.LastAppliedAt.IsZero() {
		appliedAt := summary.LastAppliedAt
		view.LastAppliedAt = &appliedAt
	}
	if snapshot, ok := s.cache.Get(summary.PodID); ok {
		mergePodMetrics(&view, snapshot)
	}
	return view, nil
}

func mergePodMetrics(view *podView, snapshot monitor.Snapshot) {
	view.CPUPercent = snapshot.CPUPercent
	view.MemMiB = snapshot.MemMiB
	view.ChannelStatuses = snapshot.ChannelStatuses
	view.SkillActive = snapshot.SkillActive
	view.SkillQueued = snapshot.SkillQueued
	view.BrowserActive = snapshot.BrowserActive
	view.BrowserQueued = snapshot.BrowserQueued
	view.RuntimeGuardHealthy = snapshot.RuntimeGuardHealthy
}

func derivePodState(pod repo.Pod, states map[string]string) string {
	if observed := states[pod.PodID]; observed != "" {
		return observed
	}
	switch pod.State {
	case repo.PodStateCreating, repo.PodStateStopped, repo.PodStateError, repo.PodStateDeleting:
		return pod.State
	default:
		return "missing"
	}
}

func listDriverStates(ctx context.Context, runtime driver.RuntimeDriver) (map[string]string, error) {
	infos, err := runtime.List(ctx)
	if err != nil {
		return nil, err
	}
	states := make(map[string]string, len(infos))
	for _, info := range infos {
		states[info.PodID] = info.State
	}
	return states, nil
}
