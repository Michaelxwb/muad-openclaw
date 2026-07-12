package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const sessionCredentialPurpose = "session_get_state"

var (
	credentialAgentPattern    = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
	credentialPlatformPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

type credentialResolveRequest struct {
	AgentID  string `json:"agentId"`
	Platform string `json:"platform"`
	Purpose  string `json:"purpose"`
}

type credentialResolveResponse struct {
	HumanUserID               string         `json:"humanUserId"`
	PodID                     string         `json:"podId"`
	AgentID                   string         `json:"agentId"`
	Platform                  string         `json:"platform"`
	CredentialFingerprint     string         `json:"credentialFingerprint"`
	PlatformConfigFingerprint string         `json:"platformConfigFingerprint"`
	APIKey                    string         `json:"apiKey"`
	SessionMode               string         `json:"sessionMode"`
	Adapter                   string         `json:"adapter"`
	PlatformConfig            map[string]any `json:"platformConfig"`
}

func (s *Server) handleResolveSessionCredential(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, codePodUnauthorized, "invalid Pod service token")
		return
	}
	var request credentialResolveRequest
	if err := decodeJSONBody(w, r, &request); err != nil || !validCredentialRequest(request) {
		s.recordResolveFailure(r, pod, request, "invalid_request", "")
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	response, err := s.resolveSessionCredential(pod, request)
	if err != nil {
		s.writeResolveError(w, r, pod, request, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func validCredentialRequest(request credentialResolveRequest) bool {
	return credentialAgentPattern.MatchString(request.AgentID) &&
		credentialPlatformPattern.MatchString(request.Platform) &&
		request.Purpose == sessionCredentialPurpose
}

func (s *Server) resolveSessionCredential(
	pod repo.Pod, request credentialResolveRequest,
) (credentialResolveResponse, error) {
	user, err := s.store.GetHumanUserByAgent(pod.PodID, request.AgentID)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	if user.Status != repo.HumanUserStatusActive {
		return credentialResolveResponse{}, repo.ErrNotFound
	}
	platform, err := s.store.GetPlatformConfig(request.Platform)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	if !platform.Enabled {
		return credentialResolveResponse{}, repo.ErrPlatformDisabled
	}
	credential, err := s.store.ResolveUserPlatformCredential(s.cipher, user.HumanUserID, request.Platform)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	config, canonical, err := s.decodePlatformConfig(platform.ConfigEnc)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	return buildCredentialResponse(user, credential, config, canonical), nil
}

func buildCredentialResponse(
	user repo.HumanUser, credential repo.ResolvedPlatformCredential,
	config map[string]any, canonical []byte,
) credentialResolveResponse {
	sessionMode := "storage_state"
	if configured, ok := config["sessionMode"].(string); ok && strings.TrimSpace(configured) != "" {
		sessionMode = configured
	}
	return credentialResolveResponse{
		HumanUserID: user.HumanUserID, PodID: user.PodID,
		AgentID: user.AgentID, Platform: credential.Platform,
		CredentialFingerprint:     credential.Fingerprint,
		PlatformConfigFingerprint: crypto.Fingerprint(string(canonical)),
		APIKey:                    credential.APIKey, SessionMode: sessionMode, Adapter: credential.Platform,
		PlatformConfig: config,
	}
}

func (s *Server) decodePlatformConfig(encrypted string) (map[string]any, []byte, error) {
	plain := "{}"
	if encrypted != "" {
		decrypted, err := s.cipher.Decrypt(encrypted)
		if err != nil {
			return nil, nil, fmt.Errorf("decrypt platform config: %w", err)
		}
		plain = decrypted
	}
	decoder := json.NewDecoder(bytes.NewBufferString(plain))
	decoder.UseNumber()
	var config map[string]any
	if err := decoder.Decode(&config); err != nil || config == nil {
		return nil, nil, errors.New("invalid platform config")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, nil, errors.New("invalid platform config")
	}
	canonical, err := json.Marshal(config)
	if err != nil {
		return nil, nil, fmt.Errorf("canonicalize platform config: %w", err)
	}
	return config, canonical, nil
}

func (s *Server) writeResolveError(
	w http.ResponseWriter, r *http.Request, pod repo.Pod,
	request credentialResolveRequest, err error,
) {
	errorCode := "internal"
	humanUserID := ""
	if user, findErr := s.store.GetHumanUserByAgent(pod.PodID, request.AgentID); findErr == nil {
		humanUserID = user.HumanUserID
	}
	switch {
	case errors.Is(err, repo.ErrCredentialNotConfigured):
		errorCode = "not_configured"
	case errors.Is(err, repo.ErrPlatformDisabled):
		errorCode = "platform_disabled"
	case errors.Is(err, repo.ErrNotFound):
		errorCode = "agent_not_active"
	}
	s.recordResolveFailure(r, pod, request, errorCode, humanUserID)
	writeRepoError(w, err)
}

func (s *Server) recordResolveFailure(
	r *http.Request, pod repo.Pod, request credentialResolveRequest,
	errorCode, humanUserID string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.PodActor(pod.PodID), Action: auditlog.ActionSessionResolveFail,
		Target: request.AgentID,
		Metadata: auditlog.Metadata{
			PodID: pod.PodID, HumanUserID: humanUserID, AgentID: request.AgentID,
			Platform: request.Platform, ErrorCode: errorCode,
		},
	})
	if err != nil {
		log.Printf("credential_resolve_audit_failed pod=%s error=%v", pod.PodID, err)
	}
}
