package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const maxPlatformConfigBytes = 16 * 1024

type createPlatformRequest struct {
	Platform    string          `json:"platform"`
	DisplayName string          `json:"displayName"`
	Config      json.RawMessage `json:"config"`
	Enabled     *bool           `json:"enabled"`
}

type patchPlatformRequest struct {
	DisplayName *string          `json:"displayName"`
	Config      *json.RawMessage `json:"config"`
	Enabled     *bool            `json:"enabled"`
}

type platformView struct {
	Platform          string         `json:"platform"`
	DisplayName       string         `json:"displayName"`
	Config            map[string]any `json:"config"`
	ConfigFingerprint string         `json:"configFingerprint"`
	Enabled           bool           `json:"enabled"`
	AdapterInstalled  bool           `json:"adapterInstalled"`
	UpdatedAt         time.Time      `json:"updatedAt"`
}

type deletePlatformResponse struct {
	Platform       string   `json:"platform"`
	Deleted        bool     `json:"deleted"`
	AffectedPodIDs []string `json:"affectedPodIds"`
}

func (s *Server) handleListPlatforms(w http.ResponseWriter, _ *http.Request) {
	configs, err := s.store.ListPlatformConfigs()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list platforms")
		return
	}
	views := make([]platformView, 0, len(configs))
	for _, config := range configs {
		view, err := s.makePlatformView(config)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, codeInternal, "decode platform configuration")
			return
		}
		views = append(views, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (s *Server) handleCreatePlatform(w http.ResponseWriter, r *http.Request) {
	var request createPlatformRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	request.Platform, request.DisplayName = strings.TrimSpace(request.Platform), strings.TrimSpace(request.DisplayName)
	if request.DisplayName == "" || len(request.DisplayName) > 128 {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid platform display name")
		return
	}
	encrypted, err := s.encodePlatformConfig(request.Config)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid platform configuration")
		return
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	podIDs, err := s.store.CreatePlatformConfigAndMarkPods(repo.PlatformConfig{
		Platform: request.Platform, DisplayName: request.DisplayName,
		ConfigEnc: encrypted, Enabled: enabled,
	})
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueuePodIDs(podIDs)
	config, err := s.store.GetPlatformConfig(request.Platform)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.auditPlatform(r, auditlog.ActionPlatformConfigCreate, config, "created")
	s.writePlatform(w, config, http.StatusCreated)
}

func (s *Server) handlePatchPlatform(w http.ResponseWriter, r *http.Request) {
	current, err := s.store.GetPlatformConfig(r.PathValue("platform"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request patchPlatformRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	next, changed, err := s.applyPlatformPatch(current, request)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid platform configuration")
		return
	}
	if changed {
		podIDs, err := s.store.UpdatePlatformConfigAndMarkPods(
			next.Platform, next.DisplayName, next.ConfigEnc, next.Enabled,
		)
		if err != nil {
			writeRepoError(w, err)
			return
		}
		s.enqueuePodIDs(podIDs)
		next, err = s.store.GetPlatformConfig(next.Platform)
		if err != nil {
			writeRepoError(w, err)
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
		writeRepoError(w, err)
		return
	}
	podIDs, err := s.store.DeletePlatformConfigAndMarkPods(s.cipher, platform)
	if err != nil {
		writeRepoError(w, err)
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
	if request.Config != nil {
		encrypted, err := s.encodePlatformConfig(*request.Config)
		if err != nil {
			return repo.PlatformConfig{}, false, err
		}
		next.ConfigEnc = encrypted
	}
	if next.DisplayName == "" || len(next.DisplayName) > 128 {
		return repo.PlatformConfig{}, false, errors.New("invalid display name")
	}
	changed := next.DisplayName != current.DisplayName || next.Enabled != current.Enabled
	if request.Config != nil {
		changed = changed || !s.equalEncryptedPlatformConfigs(current.ConfigEnc, next.ConfigEnc)
	}
	return next, changed, nil
}

func (s *Server) encodePlatformConfig(raw json.RawMessage) (string, error) {
	config, canonical, err := decodePlatformPayload(raw)
	if err != nil || containsSensitiveConfigKey(config) {
		return "", errors.New("invalid platform config")
	}
	return s.cipher.Encrypt(string(canonical))
}

func decodePlatformPayload(raw json.RawMessage) (map[string]any, []byte, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if len(raw) > maxPlatformConfigBytes {
		return nil, nil, errors.New("platform config is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var config map[string]any
	if err := decoder.Decode(&config); err != nil || config == nil {
		return nil, nil, errors.New("platform config must be an object")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, nil, errors.New("trailing platform config value")
	}
	canonical, err := json.Marshal(config)
	return config, canonical, err
}

func containsSensitiveConfigKey(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			normalized := strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key))
			if normalized == "apikey" || strings.HasSuffix(normalized, "secret") ||
				strings.HasSuffix(normalized, "token") || strings.HasSuffix(normalized, "password") ||
				strings.HasSuffix(normalized, "cookie") || containsSensitiveConfigKey(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsSensitiveConfigKey(child) {
				return true
			}
		}
	}
	return false
}

func (s *Server) equalEncryptedPlatformConfigs(left, right string) bool {
	_, leftCanonical, leftErr := s.decodePlatformConfig(left)
	_, rightCanonical, rightErr := s.decodePlatformConfig(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftCanonical, rightCanonical)
}

func (s *Server) makePlatformView(config repo.PlatformConfig) (platformView, error) {
	decoded, canonical, err := s.decodePlatformConfig(config.ConfigEnc)
	if err != nil {
		return platformView{}, err
	}
	return platformView{
		Platform: config.Platform, DisplayName: config.DisplayName, Config: decoded,
		ConfigFingerprint: secretcrypto.DisplayFingerprint(secretcrypto.Fingerprint(string(canonical))),
		Enabled:           config.Enabled, AdapterInstalled: true,
		UpdatedAt: config.UpdatedAt,
	}, nil
}

func (s *Server) writePlatform(w http.ResponseWriter, config repo.PlatformConfig, status int) {
	view, err := s.makePlatformView(config)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode platform configuration")
		return
	}
	writeJSON(w, status, view)
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
