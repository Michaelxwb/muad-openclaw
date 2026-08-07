package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const maxPlatformCredentialPayloadBytes = 16 * 1024

type putPlatformCredentialRequest struct {
	Credentials json.RawMessage `json:"credentials"`
}

type platformCredentialView struct {
	HumanUserID           string    `json:"humanUserId"`
	Platform              string    `json:"platform"`
	CredentialFingerprint string    `json:"credentialFingerprint"`
	PlatformEnabled       bool      `json:"platformEnabled"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

func (s *Server) handleListPlatformCredentials(w http.ResponseWriter, r *http.Request) {
	humanUserID := r.PathValue("humanUserId")
	if _, err := s.store.GetHumanUser(humanUserID); err != nil {
		writeRepoError(w, r, err)
		return
	}
	summaries, err := s.store.ListUserPlatformCredentials(humanUserID)
	if err != nil {
		writeErr(w, r, errcode.InternalListPlatformCredentials)
		return
	}
	platforms, err := s.store.ListPlatformConfigs()
	if err != nil {
		writeErr(w, r, errcode.InternalListPlatforms)
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
		writeRepoError(w, r, err)
		return
	}
	if user.Status == repo.HumanUserStatusDeleting {
		writeRepoError(w, r, repo.ErrInvalidStateTransition)
		return
	}
	platform := r.PathValue("platform")
	if _, err := s.store.GetPlatformConfig(platform); err != nil {
		writeErr(w, r, errcode.InvalidPlatformNotFound)
		return
	}
	var request putPlatformCredentialRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	credentials, err := decodeCredentialPayload(request.Credentials)
	if err != nil {
		writeErr(w, r, errcode.InvalidCredentialsJson)
		return
	}
	existed, err := s.hasPlatformCredential(user.HumanUserID, platform)
	if err != nil {
		writeErr(w, r, errcode.InternalInspectPlatformCredential)
		return
	}
	summary, podID, err := s.store.UpsertUserPlatformCredentialAndMarkPod(
		user.HumanUserID, platform, credentials,
	)
	if err != nil {
		writeRepoError(w, r, err)
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
		writeRepoError(w, r, err)
		return
	}
	platform := r.PathValue("platform")
	if _, err := s.store.GetPlatformConfig(platform); err != nil {
		writeErr(w, r, errcode.InvalidPlatformNotFound)
		return
	}
	summaries, err := s.store.ListUserPlatformCredentials(user.HumanUserID)
	if err != nil {
		writeErr(w, r, errcode.InternalInspectPlatformCredential)
		return
	}
	summary, found := findCredentialSummary(summaries, platform)
	if !found {
		writeRepoError(w, r, repo.ErrCredentialNotConfigured)
		return
	}
	podID, err := s.store.DeleteUserPlatformCredentialAndMarkPod(user.HumanUserID, platform)
	if err != nil {
		writeRepoError(w, r, err)
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
	summaries, err := s.store.ListUserPlatformCredentials(humanUserID)
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
		CredentialFingerprint: secretcrypto.DisplayFingerprint(summary.CredentialFingerprint),
		PlatformEnabled:       enabled, UpdatedAt: summary.UpdatedAt,
	}
}

func decodeCredentialPayload(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > maxPlatformCredentialPayloadBytes {
		return nil, errors.New("invalid credential payload")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var credentials map[string]any
	if err := decoder.Decode(&credentials); err != nil || credentials == nil {
		return nil, errors.New("credential payload must be an object")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing credential payload value")
	}
	return credentials, nil
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
			Platform: summary.Platform, Fingerprint: summary.CredentialFingerprint, Status: status,
		},
	})
	if err != nil {
		log.Printf("platform_credential_audit_failed user=%s platform=%s error=%v",
			user.HumanUserID, summary.Platform, err)
	}
}
