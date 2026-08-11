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
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const sessionCredentialPurpose = "session_get_state"

var (
	credentialAgentPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
	credentialSkillPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
)

type credentialResolveRequest struct {
	AgentID   string `json:"agentId"`
	SkillName string `json:"skillName"`
	Purpose   string `json:"purpose"`
}

type resolvedPlatformCredential struct {
	Platform              string         `json:"platform"`
	CredentialFingerprint string         `json:"credentialFingerprint"`
	Credentials           map[string]any `json:"credentials"`
}

type credentialResolveResponse struct {
	HumanUserID string                      `json:"humanUserId"`
	PodID       string                      `json:"podId"`
	AgentID     string                      `json:"agentId"`
	SkillName   string                      `json:"skillName"`
	Platforms   []resolvedPlatformCredential `json:"platforms"`
}

func (s *Server) handleResolveSessionCredential(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, r, errcode.UnauthorizedPodToken)
		return
	}
	var request credentialResolveRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		s.recordResolveFailure(r, pod, request, "invalid_request", "", "")
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	request.AgentID = strings.TrimSpace(request.AgentID)
	request.SkillName = strings.TrimSpace(request.SkillName)
	request.Purpose = strings.TrimSpace(request.Purpose)
	if !validCredentialRequest(request) {
		s.recordResolveFailure(r, pod, request, "invalid_request", "", "")
		writeErr(w, r, errcode.InvalidRequestBody)
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
		credentialSkillPattern.MatchString(request.SkillName) &&
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
	skill, err := s.resolveSkillByName(user.HumanUserID, request.SkillName)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	platforms, err := s.resolveAllPlatformCredentials(user.HumanUserID, skill)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	return credentialResolveResponse{
		HumanUserID: user.HumanUserID, PodID: user.PodID, AgentID: user.AgentID,
		SkillName: request.SkillName, Platforms: platforms,
	}, nil
}

func (s *Server) resolveSkillByName(humanUserID, skillName string) (repo.EffectiveSkill, error) {
	skills, _, err := s.store.ResolveEffectiveSkills(humanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		return repo.EffectiveSkill{}, err
	}
	for _, skill := range skills {
		if skill.Name != skillName {
			continue
		}
		return skill, nil
	}
	return repo.EffectiveSkill{}, repo.ErrNotFound
}

func (s *Server) resolveAllPlatformCredentials(
	humanUserID string, skill repo.EffectiveSkill,
) ([]resolvedPlatformCredential, error) {
	if !skill.Effective || skill.Status != repo.EffectiveSkillStatusEffective {
		return nil, resolveInactiveSkillCredentialError(skill)
	}
	if len(skill.Platforms) == 0 {
		return nil, repo.ErrSkillPlatformNotBound
	}
	platforms := make([]resolvedPlatformCredential, 0, len(skill.Platforms))
	for _, status := range skill.Platforms {
		if status.CredentialStatus != repo.SkillCredentialConfigured {
			return nil, withPlatform(status.Platform, credentialStatusError(status))
		}
		credential, err := s.store.ResolveUserPlatformCredential(humanUserID, status.Platform)
		if err != nil {
			return nil, withPlatform(status.Platform, err)
		}
		credentials, err := decodeResolvedCredentialJSON(credential.CredentialsJSON)
		if err != nil {
			return nil, withPlatform(status.Platform, err)
		}
		platforms = append(platforms, resolvedPlatformCredential{
			Platform:              status.Platform,
			CredentialFingerprint: credential.CredentialFingerprint,
			Credentials:           credentials,
		})
	}
	return platforms, nil
}

func resolveInactiveSkillCredentialError(skill repo.EffectiveSkill) error {
	if skill.Status != repo.EffectiveSkillStatusMissingCredential {
		return repo.ErrInvalidSkill
	}
	if len(skill.Platforms) == 0 {
		return repo.ErrSkillPlatformNotBound
	}
	return firstCredentialDependencyError(skill.Platforms)
}

func firstCredentialDependencyError(platforms []repo.SkillPlatformStatus) error {
	for _, platform := range platforms {
		if platform.CredentialStatus != repo.SkillCredentialConfigured {
			return withPlatform(platform.Platform, credentialStatusError(platform))
		}
	}
	return repo.ErrInvalidSkill
}

func credentialStatusError(platform repo.SkillPlatformStatus) error {
	switch platform.CredentialStatus {
	case repo.SkillCredentialMissing:
		return repo.ErrCredentialNotConfigured
	case repo.SkillCredentialPlatformDisabled:
		return repo.ErrPlatformDisabled
	case repo.SkillCredentialPlatformMissing:
		return repo.ErrNotFound
	default:
		return repo.ErrInvalidSkill
	}
}

func decodeResolvedCredentialJSON(raw string) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()
	var credentials map[string]any
	if err := decoder.Decode(&credentials); err != nil || credentials == nil {
		return nil, errors.New("invalid platform credential")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid platform credential")
	}
	return credentials, nil
}

// platformError 记录失败发生的平台，供审计定位 Option A 整体失败的具体平台。
type platformError struct {
	platform string
	err      error
}

func (e *platformError) Error() string {
	return fmt.Sprintf("platform %s: %v", e.platform, e.err)
}

func (e *platformError) Unwrap() error { return e.err }

func withPlatform(platform string, err error) error {
	return &platformError{platform: platform, err: err}
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
	case errors.Is(err, repo.ErrInvalidSkill):
		errorCode = "invalid_skill"
	case errors.Is(err, repo.ErrSkillPlatformNotBound):
		errorCode = "platform_not_bound"
	case errors.Is(err, repo.ErrNotFound):
		errorCode = "agent_or_skill_not_active"
	}
	platform := ""
	var platformErr *platformError
	if errors.As(err, &platformErr) {
		platform = platformErr.platform
	}
	s.recordResolveFailure(r, pod, request, errorCode, humanUserID, platform)
	writeRepoError(w, r, err)
}

func (s *Server) recordResolveFailure(
	r *http.Request, pod repo.Pod, request credentialResolveRequest,
	errorCode, humanUserID, platform string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.PodActor(pod.PodID), Action: auditlog.ActionSessionResolveFail,
		Target: request.AgentID,
		Metadata: auditlog.Metadata{
			PodID: pod.PodID, HumanUserID: humanUserID, AgentID: request.AgentID,
			SkillName: strings.TrimSpace(request.SkillName), ErrorCode: errorCode,
			Platform: platform,
		},
	})
	if err != nil {
		log.Printf("credential_resolve_audit_failed pod=%s error=%v", pod.PodID, err)
	}
}
