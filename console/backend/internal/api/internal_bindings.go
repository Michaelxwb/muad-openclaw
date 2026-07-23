package api

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type bindingActivateRequest struct {
	Code            string `json:"code"`
	Channel         string `json:"channel"`
	OpenClawChannel string `json:"openclawChannel"`
	AccountID       string `json:"accountId"`
	ExternalID      string `json:"externalId"`
	ExternalIDType  string `json:"externalIdType"`
	PeerKind        string `json:"peerKind"`
}

func (s *Server) handleActivateBinding(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, codePodUnauthorized, "invalid Pod service token")
		return
	}
	var request bindingActivateRequest
	if err := decodeJSONBody(w, r, &request); err != nil || !validBindingContext(pod, request) {
		s.auditBindingReject(r, pod, "invalid_context")
		writeErr(w, http.StatusBadRequest, codeInvalidBinding, "invalid binding context")
		return
	}
	if s.bindingCodec == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "binding code service unavailable")
		return
	}
	if s.reconcile == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime reconciler unavailable")
		return
	}
	limitKey := bindingLimitKey(pod.PodID, request)
	allowed, retry := s.bindingLimiter.Allow(limitKey, time.Now().UTC())
	if !allowed {
		seconds := int((retry + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.Itoa(max(1, seconds)))
		s.auditBindingReject(r, pod, "rate_limited")
		writeErr(w, http.StatusTooManyRequests, codeRateLimited, "binding attempts are rate limited")
		return
	}
	// Trim fields before persistence (validBindingContext only trimmed a copy).
	request.Code = strings.TrimSpace(request.Code)
	request.Channel = strings.TrimSpace(request.Channel)
	request.AccountID = strings.TrimSpace(request.AccountID)
	request.ExternalID = strings.TrimSpace(request.ExternalID)
	request.ExternalIDType = strings.TrimSpace(request.ExternalIDType)
	request.OpenClawChannel = strings.TrimSpace(request.OpenClawChannel)
	request.PeerKind = strings.TrimSpace(request.PeerKind)
	result, err := s.store.ActivateBindingCode(s.bindingCodec, repo.BindingActivation{
		Code: request.Code, PodID: pod.PodID, Channel: request.Channel,
		OpenClawChannel: request.OpenClawChannel, AccountID: request.AccountID,
		ExternalID: request.ExternalID, ExternalIDType: request.ExternalIDType,
		PeerKind: request.PeerKind,
	}, time.Now().UTC())
	if err != nil {
		s.auditBindingFailure(r, pod, bindingErrorStatus(err))
		s.writeBindingActivationError(w, err)
		return
	}
	s.bindingLimiter.Reset(limitKey)
	s.enqueueReconcile(pod.PodID)
	s.auditBindingSuccess(r, result)
	writeJSON(w, http.StatusOK, map[string]any{
		"identityBound": true, "configStatus": "applying",
		"humanUserId": result.HumanUser.HumanUserID, "agentId": result.HumanUser.AgentID,
		"identityId": result.Identity.IdentityID, "configGeneration": result.ConfigGeneration,
	})
}

func validBindingContext(pod repo.Pod, request bindingActivateRequest) bool {
	request.Channel = strings.TrimSpace(request.Channel)
	request.AccountID = strings.TrimSpace(request.AccountID)
	request.ExternalIDType = strings.TrimSpace(request.ExternalIDType)
	return strings.TrimSpace(request.Code) != "" && len(request.Code) <= 64 &&
		driver.IsValidChannel(request.Channel) && podUsesChannel(pod, request.Channel) &&
		request.OpenClawChannel == driver.OpenClawChannelFor(request.Channel) &&
		accountIDPattern.MatchString(request.AccountID) && request.PeerKind == "direct" &&
		strings.TrimSpace(request.ExternalID) != "" && len(request.ExternalID) <= 512 &&
		identityFieldPattern.MatchString(request.ExternalIDType)
}

func bindingLimitKey(podID string, request bindingActivateRequest) string {
	return secretcrypto.Fingerprint(strings.Join([]string{
		podID, request.Channel, request.AccountID, request.ExternalID,
	}, "\x00"))
}

func (s *Server) writeBindingActivationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repo.ErrInvalidBindingCode), errors.Is(err, repo.ErrBindingCodeScope):
		writeErr(w, http.StatusBadRequest, codeInvalidBinding, "binding code or context is invalid")
	case errors.Is(err, repo.ErrBindingCodeExpired), errors.Is(err, repo.ErrBindingCodeUsed),
		errors.Is(err, repo.ErrBindingCodeRevoked):
		writeErr(w, http.StatusConflict, codeInvalidBinding, "binding code is not usable")
	case errors.Is(err, repo.ErrIdentityExists):
		writeErr(w, http.StatusConflict, codeIdentityConflict, "sender is already bound")
	case errors.Is(err, repo.ErrInvalidStateTransition):
		writeErr(w, http.StatusConflict, codeInvalidBinding, "binding code is not usable")
	default:
		writeErr(w, http.StatusInternalServerError, codeInternal, "activate binding code")
	}
}

func bindingErrorStatus(err error) string {
	switch {
	case errors.Is(err, repo.ErrBindingCodeScope):
		return "scope_mismatch"
	case errors.Is(err, repo.ErrBindingCodeExpired):
		return "expired"
	case errors.Is(err, repo.ErrBindingCodeUsed):
		return "replayed"
	case errors.Is(err, repo.ErrBindingCodeRevoked):
		return "revoked"
	case errors.Is(err, repo.ErrIdentityExists):
		return "identity_conflict"
	default:
		return "invalid_code"
	}
}

func (s *Server) auditBindingSuccess(r *http.Request, result repo.BindingActivationResult) {
	s.auditInternalBinding(r, auditlog.ActionRuntimeGuardBind, result.Identity.IdentityID, auditlog.Metadata{
		PodID: result.HumanUser.PodID, HumanUserID: result.HumanUser.HumanUserID,
		AgentID: result.HumanUser.AgentID, IdentityID: result.Identity.IdentityID,
		Status: "bound", Generation: result.ConfigGeneration,
	})
}

func (s *Server) auditBindingFailure(r *http.Request, pod repo.Pod, status string) {
	s.auditInternalBinding(r, auditlog.ActionBindingCodeFail, pod.PodID, auditlog.Metadata{
		PodID: pod.PodID, Status: status,
	})
}

func (s *Server) auditBindingReject(r *http.Request, pod repo.Pod, status string) {
	s.auditInternalBinding(r, auditlog.ActionRuntimeGuardReject, pod.PodID, auditlog.Metadata{
		PodID: pod.PodID, Status: status,
	})
}

func (s *Server) auditInternalBinding(
	r *http.Request, action auditlog.Action, target string, metadata auditlog.Metadata,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.PodActor(metadata.PodID), Action: action, Target: target, Metadata: metadata,
	})
	if err != nil {
		log.Printf("internal_binding_audit_failed pod=%s action=%s error=%v", metadata.PodID, action, err)
	}
}
