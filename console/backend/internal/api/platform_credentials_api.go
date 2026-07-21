package api

import (
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type putPlatformCredentialRequest struct {
	APIKey string `json:"apiKey"`
}

type platformCredentialView struct {
	HumanUserID     string    `json:"humanUserId"`
	Platform        string    `json:"platform"`
	KeyFingerprint  string    `json:"keyFingerprint"`
	PlatformEnabled bool      `json:"platformEnabled"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

func (s *Server) handleListPlatformCredentials(w http.ResponseWriter, r *http.Request) {
	humanUserID := r.PathValue("humanUserId")
	if _, err := s.store.GetHumanUser(humanUserID); err != nil {
		writeRepoError(w, err)
		return
	}
	summaries, err := s.store.ListUserPlatformCredentials(s.cipher, humanUserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list platform credentials")
		return
	}
	platforms, err := s.store.ListPlatformConfigs()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list platforms")
		return
	}
	enabled := make(map[string]bool, len(platforms))
	for _, platform := range platforms {
		enabled[platform.Platform] = platform.Enabled
	}
	views := make([]platformCredentialView, 0, len(summaries))
	for _, summary := range summaries {
		views = append(views, credentialToView(humanUserID, summary, enabled[summary.Platform]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (s *Server) handlePutPlatformCredential(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	if user.Status == repo.HumanUserStatusDeleting {
		writeRepoError(w, repo.ErrInvalidStateTransition)
		return
	}
	platform := r.PathValue("platform")
	if _, err := s.store.GetPlatformConfig(platform); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "platform not found")
		return
	}
	var request putPlatformCredentialRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	request.APIKey = strings.TrimSpace(request.APIKey)
	if request.APIKey == "" || len(request.APIKey) > 4096 {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "apiKey is required")
		return
	}
	existed, err := s.hasPlatformCredential(user.HumanUserID, platform)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "inspect platform credential")
		return
	}
	summary, podID, err := s.store.UpsertUserPlatformCredentialAndMarkPod(
		s.cipher, user.HumanUserID, platform, request.APIKey,
	)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(podID)
	action := auditlog.ActionPlatformCredentialCreate
	if existed {
		action = auditlog.ActionPlatformCredentialUpdate
	}
	s.auditPlatformCredential(r, action, user, summary)
	writeJSON(w, http.StatusOK, map[string]any{
		"credential":        credentialToView(user.HumanUserID, summary, true),
		"cacheInvalidation": "on_next_resolve",
	})
}

func (s *Server) handleDeletePlatformCredential(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	platform := r.PathValue("platform")
	if _, err := s.store.GetPlatformConfig(platform); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "platform not found")
		return
	}
	summaries, err := s.store.ListUserPlatformCredentials(s.cipher, user.HumanUserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "inspect platform credential")
		return
	}
	summary, found := findCredentialSummary(summaries, platform)
	if !found {
		writeRepoError(w, repo.ErrCredentialNotConfigured)
		return
	}
	podID, err := s.store.DeleteUserPlatformCredentialAndMarkPod(s.cipher, user.HumanUserID, platform)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(podID)
	s.auditPlatformCredential(r, auditlog.ActionPlatformCredentialDelete, user, summary)
	writeJSON(w, http.StatusOK, map[string]any{
		"humanUserId": user.HumanUserID, "platform": platform, "deleted": true,
		"cacheInvalidation": "on_next_resolve",
	})
}

func (s *Server) hasPlatformCredential(humanUserID, platform string) (bool, error) {
	summaries, err := s.store.ListUserPlatformCredentials(s.cipher, humanUserID)
	if err != nil {
		return false, err
	}
	_, found := findCredentialSummary(summaries, platform)
	return found, nil
}

func findCredentialSummary(
	summaries []repo.PlatformCredentialSummary, platform string,
) (repo.PlatformCredentialSummary, bool) {
	for _, summary := range summaries {
		if summary.Platform == platform {
			return summary, true
		}
	}
	return repo.PlatformCredentialSummary{}, false
}

func credentialToView(
	humanUserID string, summary repo.PlatformCredentialSummary, enabled bool,
) platformCredentialView {
	return platformCredentialView{
		HumanUserID: humanUserID, Platform: summary.Platform,
		KeyFingerprint:  secretcrypto.DisplayFingerprint(summary.KeyFingerprint),
		PlatformEnabled: enabled, UpdatedAt: summary.UpdatedAt,
	}
}

func (s *Server) auditPlatformCredential(
	r *http.Request, action auditlog.Action, user repo.HumanUser,
	summary repo.PlatformCredentialSummary,
) {
	status := "updated"
	if action == auditlog.ActionPlatformCredentialCreate {
		status = "created"
	} else if action == auditlog.ActionPlatformCredentialDelete {
		status = "deleted"
	}
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: user.HumanUserID,
		Metadata: auditlog.Metadata{
			PodID: user.PodID, HumanUserID: user.HumanUserID, AgentID: user.AgentID,
			Platform: summary.Platform, Fingerprint: summary.KeyFingerprint, Status: status,
		},
	})
	if err != nil {
		log.Printf("platform_credential_audit_failed user=%s platform=%s error=%v",
			user.HumanUserID, summary.Platform, err)
	}
}
