package api

import (
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type createPlatformRequest struct {
	Platform    string `json:"platform"`
	DisplayName string `json:"displayName"`
	Enabled     *bool  `json:"enabled"`
}

type patchPlatformRequest struct {
	DisplayName *string `json:"displayName"`
	Enabled     *bool   `json:"enabled"`
}

type platformView struct {
	Platform    string    `json:"platform"`
	DisplayName string    `json:"displayName"`
	Enabled     bool      `json:"enabled"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type deletePlatformResponse struct {
	Platform       string   `json:"platform"`
	Deleted        bool     `json:"deleted"`
	AffectedPodIDs []string `json:"affectedPodIds"`
}

var platformIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func (s *Server) handleListPlatforms(w http.ResponseWriter, r *http.Request) {
	configs, err := s.store.ListPlatformConfigs()
	if err != nil {
		writeErr(w, r, errcode.InternalListPlatforms)
		return
	}
	views := make([]platformView, 0, len(configs))
	for _, config := range configs {
		views = append(views, makePlatformView(config))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (s *Server) handleCreatePlatform(w http.ResponseWriter, r *http.Request) {
	var request createPlatformRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	request.Platform, request.DisplayName = strings.TrimSpace(request.Platform), strings.TrimSpace(request.DisplayName)
	if err := validateCreatePlatformRequest(request); err != nil {
		writeInputValidationError(w, r, errcode.InvalidPlatformConfig, err)
		return
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	podIDs, err := s.store.CreatePlatformConfigAndMarkPods(repo.PlatformConfig{
		Platform: request.Platform, DisplayName: request.DisplayName,
		Enabled: enabled,
	})
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.enqueuePodIDs(podIDs)
	config, err := s.store.GetPlatformConfig(request.Platform)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.auditPlatform(r, auditlog.ActionPlatformConfigCreate, config, "created")
	s.writePlatform(w, config, http.StatusCreated)
}

func (s *Server) handlePatchPlatform(w http.ResponseWriter, r *http.Request) {
	current, err := s.store.GetPlatformConfig(r.PathValue("platform"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	var request patchPlatformRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	next, changed, err := s.applyPlatformPatch(current, request)
	if err != nil {
		writeInputValidationError(w, r, errcode.InvalidPlatformConfig, err)
		return
	}
	if changed {
		podIDs, err := s.store.UpdatePlatformConfigAndMarkPods(
			next.Platform, next.DisplayName, next.Enabled,
		)
		if err != nil {
			writeRepoError(w, r, err)
			return
		}
		s.enqueuePodIDs(podIDs)
		next, err = s.store.GetPlatformConfig(next.Platform)
		if err != nil {
			writeRepoError(w, r, err)
			return
		}
		action := auditlog.ActionPlatformConfigUpdate
		if current.Enabled && !next.Enabled {
			action = auditlog.ActionPlatformConfigDisable
		}
		s.auditPlatform(r, action, next, "updated")
	}
	s.writePlatform(w, next, http.StatusOK)
}

func (s *Server) handleDeletePlatform(w http.ResponseWriter, r *http.Request) {
	platform := strings.TrimSpace(r.PathValue("platform"))
	current, err := s.store.GetPlatformConfig(platform)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	podIDs, err := s.store.DeletePlatformConfigAndMarkPods(platform)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.enqueuePodIDs(podIDs)
	s.auditPlatform(r, auditlog.ActionPlatformConfigDelete, current, "deleted")
	writeJSON(w, http.StatusOK, deletePlatformResponse{
		Platform: platform, Deleted: true, AffectedPodIDs: podIDs,
	})
}

func (s *Server) applyPlatformPatch(
	current repo.PlatformConfig, request patchPlatformRequest,
) (repo.PlatformConfig, bool, error) {
	next := current
	if request.DisplayName != nil {
		next.DisplayName = strings.TrimSpace(*request.DisplayName)
	}
	if request.Enabled != nil {
		next.Enabled = *request.Enabled
	}
	if err := validatePlatformDisplayName(next.DisplayName); err != nil {
		return repo.PlatformConfig{}, false, err
	}
	changed := next.DisplayName != current.DisplayName || next.Enabled != current.Enabled
	return next, changed, nil
}

func validateCreatePlatformRequest(request createPlatformRequest) error {
	if !platformIdentifierPattern.MatchString(request.Platform) {
		return newInputValidationError(
			errcode.InvalidPlatform,
			"platform 必须以小写字母开头，只能包含小写字母、数字和下划线，最长 64 位",
			"platform must start with a lowercase letter and contain lowercase letters, digits, or underscores, max 64 characters",
		)
	}
	return validatePlatformDisplayName(request.DisplayName)
}

func validatePlatformDisplayName(displayName string) error {
	if strings.TrimSpace(displayName) == "" || len(displayName) > 128 {
		return newInputValidationError(
			errcode.InvalidPlatformDisplayName,
			"displayName 不能为空，且不能超过 128 个字符",
			"displayName is required and must be at most 128 characters",
		)
	}
	return nil
}

func makePlatformView(config repo.PlatformConfig) platformView {
	return platformView{
		Platform: config.Platform, DisplayName: config.DisplayName,
		Enabled:   config.Enabled,
		UpdatedAt: config.UpdatedAt,
	}
}

func (s *Server) writePlatform(w http.ResponseWriter, config repo.PlatformConfig, status int) {
	writeJSON(w, status, makePlatformView(config))
}

func (s *Server) enqueuePodIDs(podIDs []string) {
	for _, podID := range podIDs {
		s.enqueueReconcile(podID)
	}
}

func (s *Server) auditPlatform(
	r *http.Request, action auditlog.Action, config repo.PlatformConfig, status string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: config.Platform,
		Metadata: auditlog.Metadata{Platform: config.Platform, Status: status},
	})
	if err != nil {
		log.Printf("platform_audit_failed platform=%s action=%s error=%v", config.Platform, action, err)
	}
}
