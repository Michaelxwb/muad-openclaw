package api

import (
	"bytes"
	"encoding/json"
	"errors"
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
	credentialAgentPattern    = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
	credentialSkillPattern    = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	credentialPlatformPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

type credentialResolveRequest struct {
	AgentID   string `json:"agentId"`
	SkillName string `json:"skillName"`
	Platform  string `json:"platform,omitempty"`
	Purpose   string `json:"purpose"`
}

type credentialResolveResponse struct {
	HumanUserID           string         `json:"humanUserId"`
	PodID                 string         `json:"podId"`
	AgentID               string         `json:"agentId"`
	SkillName             string         `json:"skillName"`
	Platform              string         `json:"platform"`
	CredentialFingerprint string         `json:"credentialFingerprint"`
	Credentials           map[string]any `json:"credentials"`
}

func (s *Server) handleResolveSessionCredential(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, r, errcode.UnauthorizedPodToken)
		return
	}
	var request credentialResolveRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		s.recordResolveFailure(r, pod, request, "invalid_request", "")
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	request.AgentID = strings.TrimSpace(request.AgentID)
	request.SkillName = strings.TrimSpace(request.SkillName)
	request.Platform = strings.TrimSpace(request.Platform)
	request.Purpose = strings.TrimSpace(request.Purpose)
	if !validCredentialRequest(request) {
		s.recordResolveFailure(r, pod, request, "invalid_request", "")
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
		(request.Platform == "" || credentialPlatformPattern.MatchString(request.Platform)) &&
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
	platform, err := s.resolveSkillPlatform(user.HumanUserID, request.SkillName, request.Platform)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	credential, err := s.store.ResolveUserPlatformCredential(user.HumanUserID, platform)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	credentials, err := decodeResolvedCredentialJSON(credential.CredentialsJSON)
	if err != nil {
		return credentialResolveResponse{}, err
	}
	return credentialResolveResponse{
		HumanUserID: user.HumanUserID, PodID: user.PodID, AgentID: user.AgentID,
		SkillName: request.SkillName, Platform: platform,
		CredentialFingerprint: credential.CredentialFingerprint,
		Credentials:           credentials,
	}, nil
}

func (s *Server) resolveSkillPlatform(humanUserID, skillName, requested string) (string, error) {
	skills, _, err := s.store.ResolveEffectiveSkills(humanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		return "", err
	}
	for _, skill := range skills {
		if skill.Name != skillName {
			continue
		}
		return resolveCredentialPlatform(skill, requested)
	}
	return "", repo.ErrNotFound
}

func resolveCredentialPlatform(skill repo.EffectiveSkill, requested string) (string, error) {
	if !skill.Effective || skill.Status != repo.EffectiveSkillStatusEffective {
		return "", resolveInactiveSkillCredentialError(skill, requested)
	}
	if requested != "" {
		return resolveRequestedCredentialPlatform(skill.Platforms, requested)
	}
	switch len(skill.Platforms) {
	case 0:
		return "", repo.ErrSkillPlatformNotBound
	case 1:
		return skill.Platforms[0].Platform, nil
	default:
		return "", repo.ErrSkillPlatformRequired
	}
}

func resolveInactiveSkillCredentialError(skill repo.EffectiveSkill, requested string) error {
	if skill.Status != repo.EffectiveSkillStatusMissingCredential {
		return repo.ErrInvalidSkill
	}
	if requested != "" {
		if err := requestedPlatformStatusError(skill.Platforms, requested); err != nil {
			return err
		}
		return firstCredentialDependencyError(skill.Platforms)
	}
	if len(skill.Platforms) == 0 {
		return repo.ErrSkillPlatformNotBound
	}
	if len(skill.Platforms) > 1 {
		return repo.ErrSkillPlatformRequired
	}
	return credentialStatusError(skill.Platforms[0])
}

func resolveRequestedCredentialPlatform(
	platforms []repo.SkillPlatformStatus, requested string,
) (string, error) {
	for _, platform := range platforms {
		if platform.Platform != requested {
			continue
		}
		if platform.CredentialStatus == repo.SkillCredentialConfigured {
			return requested, nil
		}
		return "", credentialStatusError(platform)
	}
	return "", repo.ErrSkillPlatformNotBound
}

func requestedPlatformStatusError(
	platforms []repo.SkillPlatformStatus, requested string,
) error {
	for _, platform := range platforms {
		if platform.Platform != requested {
			continue
		}
		if platform.CredentialStatus == repo.SkillCredentialConfigured {
			return nil
		}
		return credentialStatusError(platform)
	}
	return repo.ErrSkillPlatformNotBound
}

func firstCredentialDependencyError(platforms []repo.SkillPlatformStatus) error {
	for _, platform := range platforms {
		if platform.CredentialStatus != repo.SkillCredentialConfigured {
			return credentialStatusError(platform)
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
	case errors.Is(err, repo.ErrSkillPlatformRequired):
		errorCode = "platform_required"
	case errors.Is(err, repo.ErrSkillPlatformNotBound):
		errorCode = "platform_not_bound"
	case errors.Is(err, repo.ErrNotFound):
		errorCode = "agent_or_skill_not_active"
	}
	s.recordResolveFailure(r, pod, request, errorCode, humanUserID)
	writeRepoError(w, r, err)
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
			SkillName: strings.TrimSpace(request.SkillName), Platform: request.Platform,
			ErrorCode: errorCode,
		},
	})
	if err != nil {
		log.Printf("credential_resolve_audit_failed pod=%s error=%v", pod.PodID, err)
	}
}
