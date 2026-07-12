package api

import (
	"log"
	"net/http"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type bindingCodeView struct {
	BindingCodeID   string     `json:"bindingCodeId"`
	CodeHint        string     `json:"codeHint"`
	HumanUserID     string     `json:"humanUserId"`
	PodID           string     `json:"podId"`
	Channel         string     `json:"channel"`
	OpenClawChannel string     `json:"openclawChannel"`
	AccountID       string     `json:"accountId"`
	Purpose         string     `json:"purpose"`
	Status          string     `json:"status"`
	FailedAttempts  int        `json:"failedAttempts"`
	ExpiresAt       time.Time  `json:"expiresAt"`
	UsedAt          *time.Time `json:"usedAt,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
}

func (s *Server) handleCreateBindingCode(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	pod, err := s.store.GetPod(user.PodID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request activationInput
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	bindingRequest, err := normalizeActivationInput(pod, request)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	if s.bindingCodec == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "binding code service unavailable")
		return
	}
	bindingRequest.HumanUserID, bindingRequest.PodID = user.HumanUserID, user.PodID
	bindingRequest.Purpose = repo.BindingPurposeAddIdentity
	record, plain, err := s.store.CreateBindingCode(s.bindingCodec, bindingRequest)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.auditBindingCode(r, auditlog.ActionBindingCodeCreate, record, "created")
	writeJSON(w, http.StatusCreated, map[string]any{
		"bindingCode": bindingCodeToView(record), "code": plain,
	})
}

func (s *Server) handleListBindingCodes(w http.ResponseWriter, r *http.Request) {
	humanUserID := r.PathValue("humanUserId")
	if _, err := s.store.GetHumanUser(humanUserID); err != nil {
		writeRepoError(w, err)
		return
	}
	if _, err := s.store.ExpireBindingCodes(time.Now().UTC()); err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "expire binding codes")
		return
	}
	records, err := s.store.ListBindingCodesByHumanUser(humanUserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list binding codes")
		return
	}
	views := make([]bindingCodeView, 0, len(records))
	for _, record := range records {
		views = append(views, bindingCodeToView(record))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (s *Server) handleRevokeBindingCode(w http.ResponseWriter, r *http.Request) {
	record, ok := s.bindingCodeForPath(w, r)
	if !ok {
		return
	}
	if err := s.store.RevokeBindingCode(record.BindingCodeID); err != nil {
		writeRepoError(w, err)
		return
	}
	record.Status = repo.BindingCodeStatusRevoked
	s.auditBindingCode(r, auditlog.ActionBindingCodeRevoke, record, "revoked")
	writeJSON(w, http.StatusOK, bindingCodeToView(record))
}

func (s *Server) bindingCodeForPath(w http.ResponseWriter, r *http.Request) (repo.BindingCode, bool) {
	record, err := s.store.GetBindingCode(r.PathValue("bindingCodeId"))
	if err != nil {
		writeRepoError(w, err)
		return repo.BindingCode{}, false
	}
	if record.HumanUserID != r.PathValue("humanUserId") {
		writeErr(w, http.StatusNotFound, codeNotFound, "resource not found")
		return repo.BindingCode{}, false
	}
	return record, true
}

func bindingCodeToView(record repo.BindingCode) bindingCodeView {
	view := bindingCodeView{
		BindingCodeID: record.BindingCodeID, CodeHint: record.CodeHint,
		HumanUserID: record.HumanUserID, PodID: record.PodID, Channel: record.Channel,
		OpenClawChannel: record.OpenClawChannel, AccountID: record.AccountID,
		Purpose: record.Purpose, Status: record.Status, FailedAttempts: record.FailedAttempts,
		ExpiresAt: record.ExpiresAt, CreatedAt: record.CreatedAt,
	}
	if !record.UsedAt.IsZero() {
		usedAt := record.UsedAt
		view.UsedAt = &usedAt
	}
	return view
}

func (s *Server) auditBindingCode(
	r *http.Request, action auditlog.Action, record repo.BindingCode, status string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: record.BindingCodeID,
		Metadata: auditlog.Metadata{
			PodID: record.PodID, HumanUserID: record.HumanUserID,
			BindingCodeID: record.BindingCodeID, Status: status,
		},
	})
	if err != nil {
		log.Printf("binding_code_audit_failed id=%s action=%s error=%v", record.BindingCodeID, action, err)
	}
}
