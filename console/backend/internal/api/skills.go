package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const maxPrivateSkillBundleBytes = 5 * 1024 * 1024

type patchSkillRequest struct {
	Status *string `json:"status"`
}

type createSkillPolicyRequest struct {
	SkillName string     `json:"skillName"`
	Action    string     `json:"action"`
	Reason    string     `json:"reason"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type privateSkillInstallResult struct {
	OK                bool     `json:"ok"`
	Name              string   `json:"name"`
	Version           string   `json:"version"`
	Platforms         []string `json:"platforms"`
	ProgressSupported bool     `json:"progressSupported"`
	BrowserRequired   bool     `json:"browserRequired"`
	EntryType         string   `json:"entryType"`
	ManifestHash      string   `json:"manifestHash"`
	ManifestJSON      string   `json:"manifestJson"`
	TargetDir         string   `json:"targetDir"`
}

type skillBundleUpload struct {
	Body         []byte
	ExpectedName string
	Format       string
}

type skillAssetView struct {
	SkillID           string    `json:"skillId"`
	Name              string    `json:"name"`
	Scope             string    `json:"scope"`
	HumanUserID       string    `json:"humanUserId,omitempty"`
	PodID             string    `json:"podId,omitempty"`
	DisplayName       string    `json:"displayName"`
	Version           string    `json:"version"`
	Status            string    `json:"status"`
	SourcePath        string    `json:"sourcePath"`
	ManifestHash      string    `json:"manifestHash"`
	ManifestJSON      string    `json:"manifestJson"`
	EntryType         string    `json:"entryType"`
	PlatformsJSON     string    `json:"platformsJson"`
	BrowserRequired   bool      `json:"browserRequired"`
	ProgressSupported bool      `json:"progressSupported"`
	SystemProtected   bool      `json:"systemProtected"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type effectiveSkillView struct {
	Name              string                 `json:"name"`
	DisplayName       string                 `json:"displayName"`
	Effective         bool                   `json:"effective"`
	EffectiveSource   string                 `json:"effectiveSource"`
	Status            string                 `json:"status"`
	Version           string                 `json:"version"`
	SystemSkillID     string                 `json:"systemSkillId,omitempty"`
	PublicSkillID     string                 `json:"publicSkillId,omitempty"`
	PrivateSkillID    string                 `json:"privateSkillId,omitempty"`
	Conflict          bool                   `json:"conflict"`
	ConflictReason    string                 `json:"conflictReason,omitempty"`
	Platforms         []skillPlatformView    `json:"platforms"`
	ProgressSupported bool                   `json:"progressSupported"`
	BrowserRequired   bool                   `json:"browserRequired"`
	RuntimePending    bool                   `json:"runtimePending"`
	LastExecution     *skillExecutionSummary `json:"lastExecution,omitempty"`
}

type skillPlatformView struct {
	Platform         string `json:"platform"`
	CredentialStatus string `json:"credentialStatus"`
	PlatformEnabled  bool   `json:"platformEnabled"`
}

type skillExecutionSummary struct {
	ExecutionID string    `json:"executionId"`
	Status      string    `json:"status"`
	StartedAt   time.Time `json:"startedAt"`
	DurationMS  int64     `json:"durationMs"`
}

type publicSkillStorageView struct {
	Driver       string `json:"driver"`
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Configured   bool   `json:"configured"`
	Ready        bool   `json:"ready"`
	Phase        string `json:"phase"`
	AccessMode   string `json:"accessMode"`
	StorageClass string `json:"storageClass"`
	Size         string `json:"size"`
	Message      string `json:"message"`
}

type skillPolicyView struct {
	PolicyID    string    `json:"policyId"`
	HumanUserID string    `json:"humanUserId"`
	SkillName   string    `json:"skillName"`
	Action      string    `json:"action"`
	Reason      string    `json:"reason"`
	CreatedBy   string    `json:"createdBy"`
	ExpiresAt   time.Time `json:"expiresAt,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (s *Server) handleGetPublicSkillStorage(w http.ResponseWriter, r *http.Request) {
	status, err := s.drv.PublicSkillsStorageStatus(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "inspect public Skill storage failed")
		return
	}
	writeJSON(w, http.StatusOK, publicSkillStorageToView(status))
}

func (s *Server) handleEnsurePublicSkillStorage(w http.ResponseWriter, r *http.Request) {
	status, err := s.drv.EnsurePublicSkillsStorage(r.Context())
	if err != nil {
		if errors.Is(err, driver.ErrInvalidPodSpec) {
			writeErr(w, http.StatusBadRequest, codeInvalidField, "public Skill storage is not configured")
			return
		}
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "create public Skill storage failed")
		return
	}
	writeJSON(w, http.StatusOK, publicSkillStorageToView(status))
}

func (s *Server) handleListSkills(w http.ResponseWriter, r *http.Request) {
	filter, page, pageSize, ok := skillAssetFilterFromRequest(w, r)
	if !ok {
		return
	}
	assets, total, err := s.store.ListSkillAssets(filter)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Skills")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": skillAssetViews(assets), "total": total, "page": page, "pageSize": pageSize,
	})
}

func (s *Server) handleGetSkill(w http.ResponseWriter, r *http.Request) {
	asset, err := s.store.GetSkillAsset(r.PathValue("skillId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, skillAssetToView(asset))
}

func (s *Server) handleScanSkills(w http.ResponseWriter, r *http.Request) {
	assets, total, err := s.store.ListSkillAssets(repo.SkillAssetListFilter{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "scan Skills")
		return
	}
	s.auditSkill(r, auditlog.ActionSkillAssetScan, repo.SkillAsset{}, "scanned", total)
	writeJSON(w, http.StatusOK, map[string]any{"scanned": total, "items": skillAssetViews(assets)})
}

func (s *Server) handleUploadPublicSkill(w http.ResponseWriter, r *http.Request) {
	if !s.publicSkillStorageReady(w, r) {
		return
	}
	bundle, ok := readPublicSkillUpload(w, r)
	if !ok {
		return
	}
	result, err := installPublicSkillBundle(bundle, s.cfg.SkillsDir, s.rejectPublicSkillConflict)
	if err != nil {
		log.Printf("public_skill_upload_invalid error=%v", err)
		writeErr(w, http.StatusBadRequest, codeInvalidField, publicSkillBundleClientMessage(err))
		return
	}
	asset, podIDs, err := s.store.UpsertPublicSkillAssetAndMarkPods(repo.SkillAsset{
		Name: result.Name, Scope: repo.SkillScopePublic, DisplayName: result.Name,
		Version: result.Version, SourcePath: result.TargetDir, ManifestHash: result.ManifestHash,
		ManifestJSON: result.ManifestJSON, EntryType: result.EntryType,
		PlatformsJSON:     mustMarshalStringSlice(result.Platforms),
		ProgressSupported: result.ProgressSupported, BrowserRequired: result.BrowserRequired,
	})
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueuePodIDs(podIDs)
	s.auditSkill(r, auditlog.ActionSkillAssetInstall, asset, "installed", len(podIDs))
	writeJSON(w, http.StatusCreated, map[string]any{
		"skill": skillAssetToView(asset), "affectedPodIds": podIDs,
	})
}

func (s *Server) publicSkillStorageReady(w http.ResponseWriter, r *http.Request) bool {
	status, err := s.drv.PublicSkillsStorageStatus(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "inspect public Skill storage failed")
		return false
	}
	if status.Ready {
		return true
	}
	writeErr(w, http.StatusConflict, codeConflict, "public Skill storage is not ready")
	return false
}

func (s *Server) handlePatchSkill(w http.ResponseWriter, r *http.Request) {
	var request patchSkillRequest
	if err := decodeJSONBody(w, r, &request); err != nil || request.Status == nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	status := strings.TrimSpace(*request.Status)
	if status == repo.SkillStatusDeleted {
		if !s.removePublicSkillBeforeDelete(w, r.PathValue("skillId")) {
			return
		}
	}
	asset, podIDs, err := s.store.UpdateSkillAssetStatusAndMarkPods(
		r.PathValue("skillId"), status,
	)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueuePodIDs(podIDs)
	s.auditSkill(r, auditlog.ActionSkillAssetUpdate, asset, asset.Status, len(podIDs))
	writeJSON(w, http.StatusOK, map[string]any{
		"skill": skillAssetToView(asset), "affectedPodIds": podIDs,
	})
}

func (s *Server) removePublicSkillBeforeDelete(w http.ResponseWriter, skillID string) bool {
	asset, err := s.store.GetSkillAsset(skillID)
	if err != nil {
		writeRepoError(w, err)
		return false
	}
	if asset.Scope != repo.SkillScopePublic {
		writeRepoError(w, repo.ErrInvalidSkill)
		return false
	}
	if err := removePublicSkillDirectory(s.cfg.SkillsDir, asset.Name); err != nil {
		log.Printf("public_skill_delete_failed skill=%s error=%v", asset.Name, err)
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "delete public Skill failed")
		return false
	}
	return true
}

func (s *Server) handleListHumanUserSkills(w http.ResponseWriter, r *http.Request) {
	filter := repo.EffectiveSkillFilter{
		Query:  strings.TrimSpace(r.URL.Query().Get("q")),
		Status: strings.TrimSpace(r.URL.Query().Get("status")),
	}
	skills, total, err := s.store.ResolveEffectiveSkills(s.cipher, r.PathValue("humanUserId"), filter)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": effectiveSkillViews(skills), "total": total})
}

func (s *Server) handleCreateSkillPolicy(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request createSkillPolicyRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	policy := repo.SkillPolicy{
		HumanUserID: user.HumanUserID, SkillName: strings.TrimSpace(request.SkillName),
		Action: strings.TrimSpace(request.Action), Reason: request.Reason,
		CreatedBy: actorFrom(r.Context()),
	}
	if request.ExpiresAt != nil {
		policy.ExpiresAt = *request.ExpiresAt
	}
	created, podID, err := s.store.CreateSkillPolicyAndMarkPod(policy)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(podID)
	s.auditSkillPolicy(r, auditlog.ActionSkillPolicyCreate, created, podID, "created")
	writeJSON(w, http.StatusCreated, skillPolicyToView(created))
}

func (s *Server) handleUploadPrivateSkill(w http.ResponseWriter, r *http.Request) {
	user, pod, ok := s.privateSkillTarget(w, r.PathValue("humanUserId"))
	if !ok {
		return
	}
	upload, ok := readPrivateSkillUpload(w, r)
	if !ok {
		return
	}
	result, err := s.installPrivateSkillInPod(
		r, pod.PodID, user.AgentID, upload.ExpectedName, upload.Format, upload.Body,
	)
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "runtime failure")
		return
	}
	if err := s.rejectPrivateSkillConflict(result.Name, user.HumanUserID); err != nil {
		_ = s.deletePrivateSkillInPod(r, pod.PodID, user.AgentID, result.Name)
		writeRepoError(w, err)
		return
	}
	asset, err := s.store.CreatePrivateSkillAssetAndMarkPod(repo.SkillAsset{
		Name: result.Name, Scope: repo.SkillScopePrivate, HumanUserID: user.HumanUserID,
		PodID: pod.PodID, DisplayName: result.Name, Version: result.Version,
		SourcePath: result.TargetDir, ManifestHash: result.ManifestHash,
		ManifestJSON: result.ManifestJSON, EntryType: result.EntryType,
		PlatformsJSON:     mustMarshalStringSlice(result.Platforms),
		ProgressSupported: result.ProgressSupported, BrowserRequired: result.BrowserRequired,
	})
	if err != nil {
		_ = s.deletePrivateSkillInPod(r, pod.PodID, user.AgentID, result.Name)
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditSkill(r, auditlog.ActionSkillAssetInstall, asset, "installed", 1)
	writeJSON(w, http.StatusCreated, map[string]any{"skill": skillAssetToView(asset)})
}

func (s *Server) handleDeletePrivateSkill(w http.ResponseWriter, r *http.Request) {
	user, pod, ok := s.privateSkillTarget(w, r.PathValue("humanUserId"))
	if !ok {
		return
	}
	asset, err := s.store.GetSkillAsset(r.PathValue("skillId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	if asset.Scope != repo.SkillScopePrivate || asset.HumanUserID != user.HumanUserID {
		writeRepoError(w, repo.ErrNotFound)
		return
	}
	if err := s.deletePrivateSkillInPod(r, pod.PodID, user.AgentID, asset.Name); err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "runtime failure")
		return
	}
	deleted, err := s.store.DeletePrivateSkillAssetAndMarkPod(asset.SkillID, user.HumanUserID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditSkill(r, auditlog.ActionSkillAssetDelete, deleted, "deleted", 1)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "skillId": asset.SkillID})
}

func (s *Server) handleDeleteSkillPolicy(w http.ResponseWriter, r *http.Request) {
	if _, err := s.store.GetHumanUser(r.PathValue("humanUserId")); err != nil {
		writeRepoError(w, err)
		return
	}
	podID, err := s.store.DeleteSkillPolicyForHumanUserAndMarkPod(
		r.PathValue("policyId"), r.PathValue("humanUserId"),
	)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(podID)
	s.auditSkillPolicy(r, auditlog.ActionSkillPolicyDelete, repo.SkillPolicy{
		PolicyID: r.PathValue("policyId"), HumanUserID: r.PathValue("humanUserId"),
	}, podID, "deleted")
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "policyId": r.PathValue("policyId")})
}

func (s *Server) privateSkillTarget(
	w http.ResponseWriter, humanUserID string,
) (repo.HumanUser, repo.Pod, bool) {
	user, err := s.store.GetHumanUser(humanUserID)
	if err != nil {
		writeRepoError(w, err)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	pod, err := s.store.GetPod(user.PodID)
	if err != nil {
		writeRepoError(w, err)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	if pod.State != repo.PodStateRunning {
		writeErr(w, http.StatusConflict, codePodStateConflict, "Pod state does not allow this operation")
		return repo.HumanUser{}, repo.Pod{}, false
	}
	return user, pod, true
}

func readPrivateSkillUpload(w http.ResponseWriter, r *http.Request) (skillBundleUpload, bool) {
	return readSkillBundleUpload(w, r, ".tar.gz", ".zip")
}

func readPublicSkillUpload(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	upload, ok := readSkillBundleUpload(w, r, ".tar.gz", ".zip")
	return upload.Body, ok
}

func readSkillBundleUpload(w http.ResponseWriter, r *http.Request, allowedExts ...string) (skillBundleUpload, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPrivateSkillBundleBytes+1024*1024)
	if err := r.ParseMultipartForm(maxPrivateSkillBundleBytes); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return skillBundleUpload{}, false
	}
	file, header, err := r.FormFile("bundle")
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid skill bundle")
		return skillBundleUpload{}, false
	}
	defer file.Close()
	format, ok := skillBundleFormat(header.Filename, allowedExts)
	if header.Size > maxPrivateSkillBundleBytes || !ok {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid skill bundle")
		return skillBundleUpload{}, false
	}
	var buffer bytes.Buffer
	if _, err := buffer.ReadFrom(file); err != nil || buffer.Len() == 0 ||
		buffer.Len() > maxPrivateSkillBundleBytes {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid skill bundle")
		return skillBundleUpload{}, false
	}
	return skillBundleUpload{
		Body: buffer.Bytes(), ExpectedName: strings.TrimSpace(r.FormValue("expectedName")),
		Format: format,
	}, true
}

func skillBundleFormat(filename string, allowedExts []string) (string, bool) {
	name := strings.ToLower(strings.TrimSpace(filename))
	for _, ext := range allowedExts {
		if strings.HasSuffix(name, ext) {
			return strings.TrimPrefix(ext, "."), true
		}
	}
	return "", false
}

func publicSkillBundleClientMessage(err error) string {
	message := err.Error()
	switch {
	case strings.Contains(message, "exactly one SKILL.md"):
		return "Skill 包必须且只能包含一个 SKILL.md"
	case strings.Contains(message, "invalid skill name"):
		return "Skill 名称非法，请在 muad.skill.json.name 中使用小写字母、数字、- 或 _"
	case strings.Contains(message, "invalid platform dependency"):
		return "Skill 平台依赖非法"
	case strings.Contains(message, "decode Skill manifest"):
		return "muad.skill.json 格式非法"
	case strings.Contains(message, "parent path") ||
		strings.Contains(message, "absolute path") ||
		strings.Contains(message, "invalid path") ||
		strings.Contains(message, "escapes"):
		return "Skill 包包含不安全路径"
	case strings.Contains(message, "link"):
		return "Skill 包不能包含软链接或硬链接"
	default:
		return "invalid skill bundle"
	}
}

func (s *Server) installPrivateSkillInPod(
	r *http.Request, podID, agentID, expectedName, format string, bundle []byte,
) (privateSkillInstallResult, error) {
	args := []string{
		"node", "/opt/muad/private-skill-installer.mjs", "install",
		"--agent-id", agentID, "--bundle-format", format,
	}
	if expectedName != "" {
		args = append(args, "--expected-name", expectedName)
	}
	output, err := s.drv.ExecStdin(r.Context(), podID, bytes.NewReader(bundle), args...)
	if err != nil {
		log.Printf("private_skill_install_failed pod=%s agent=%s error=%v", podID, agentID, err)
		return privateSkillInstallResult{}, err
	}
	var result privateSkillInstallResult
	if err := json.Unmarshal([]byte(output), &result); err != nil || !result.OK || result.Name == "" {
		return privateSkillInstallResult{}, errors.New("invalid installer response")
	}
	return result, nil
}

func (s *Server) deletePrivateSkillInPod(
	r *http.Request, podID, agentID, skillName string,
) error {
	_, err := s.drv.ExecStdin(r.Context(), podID, strings.NewReader(""),
		"node", "/opt/muad/private-skill-installer.mjs", "delete",
		"--agent-id", agentID, "--skill-name", skillName)
	if err != nil {
		log.Printf("private_skill_delete_failed pod=%s agent=%s skill=%s error=%v", podID, agentID, skillName, err)
	}
	return err
}

func (s *Server) rejectPrivateSkillConflict(name, humanUserID string) error {
	assets, err := s.store.ListSkillAssetsByName(name)
	if err != nil {
		return err
	}
	allowOverride, err := s.hasAllowOverridePolicy(humanUserID, name)
	if err != nil {
		return err
	}
	for _, asset := range assets {
		if asset.Scope == repo.SkillScopeSystem {
			return repo.ErrInvalidSkill
		}
		if asset.Scope == repo.SkillScopePublic && !allowOverride {
			return repo.ErrSkillExists
		}
	}
	return nil
}

func (s *Server) rejectPublicSkillConflict(name string) error {
	assets, err := s.store.ListSkillAssetsByName(name)
	if err != nil {
		return err
	}
	for _, asset := range assets {
		if asset.Scope == repo.SkillScopeSystem {
			return repo.ErrInvalidSkill
		}
	}
	return nil
}

func (s *Server) hasAllowOverridePolicy(humanUserID, skillName string) (bool, error) {
	policies, err := s.store.ListSkillPoliciesByHumanUser(humanUserID)
	if err != nil {
		return false, err
	}
	for _, policy := range policies {
		if policy.SkillName == skillName && policy.Action == repo.SkillPolicyAllowOverride {
			return true, nil
		}
	}
	return false, nil
}

func mustMarshalStringSlice(values []string) string {
	encoded, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

func skillAssetFilterFromRequest(
	w http.ResponseWriter, r *http.Request,
) (repo.SkillAssetListFilter, int, int, bool) {
	page, pageSize := parsePodPagination(r)
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if scope != "" && !validSkillScope(scope) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Skill scope")
		return repo.SkillAssetListFilter{}, 0, 0, false
	}
	if status != "" && !validSkillStatus(status) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Skill status")
		return repo.SkillAssetListFilter{}, 0, 0, false
	}
	return repo.SkillAssetListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize,
		Query: strings.TrimSpace(r.URL.Query().Get("q")), Scope: scope, Status: status,
		HumanUserID: strings.TrimSpace(r.URL.Query().Get("humanUserId")),
		PodID:       strings.TrimSpace(r.URL.Query().Get("podId")),
	}, page, pageSize, true
}

func skillAssetViews(assets []repo.SkillAsset) []skillAssetView {
	views := make([]skillAssetView, 0, len(assets))
	for _, asset := range assets {
		views = append(views, skillAssetToView(asset))
	}
	return views
}

func skillAssetToView(asset repo.SkillAsset) skillAssetView {
	return skillAssetView{
		SkillID: asset.SkillID, Name: asset.Name, Scope: asset.Scope,
		HumanUserID: asset.HumanUserID, PodID: asset.PodID, DisplayName: asset.DisplayName,
		Version: asset.Version, Status: asset.Status, SourcePath: asset.SourcePath,
		ManifestHash: asset.ManifestHash, ManifestJSON: asset.ManifestJSON,
		EntryType: asset.EntryType, PlatformsJSON: asset.PlatformsJSON,
		BrowserRequired: asset.BrowserRequired, ProgressSupported: asset.ProgressSupported,
		SystemProtected: asset.SystemProtected, CreatedAt: asset.CreatedAt, UpdatedAt: asset.UpdatedAt,
	}
}

func effectiveSkillViews(skills []repo.EffectiveSkill) []effectiveSkillView {
	views := make([]effectiveSkillView, 0, len(skills))
	for _, skill := range skills {
		views = append(views, effectiveSkillToView(skill))
	}
	return views
}

func effectiveSkillToView(skill repo.EffectiveSkill) effectiveSkillView {
	view := effectiveSkillView{
		Name: skill.Name, DisplayName: skill.DisplayName, Effective: skill.Effective,
		EffectiveSource: skill.EffectiveSource, Status: skill.Status, Version: skill.Version,
		SystemSkillID: skill.SystemSkillID, PublicSkillID: skill.PublicSkillID,
		PrivateSkillID: skill.PrivateSkillID, Conflict: skill.Conflict,
		ConflictReason: skill.ConflictReason, ProgressSupported: skill.ProgressSupported,
		BrowserRequired: skill.BrowserRequired, RuntimePending: skill.RuntimePending,
	}
	for _, platform := range skill.Platforms {
		view.Platforms = append(view.Platforms, skillPlatformView{
			Platform: platform.Platform, CredentialStatus: platform.CredentialStatus,
			PlatformEnabled: platform.PlatformEnabled,
		})
	}
	if skill.LastExecution != nil {
		view.LastExecution = &skillExecutionSummary{
			ExecutionID: skill.LastExecution.ExecutionID, Status: skill.LastExecution.Status,
			StartedAt: skill.LastExecution.StartedAt, DurationMS: skill.LastExecution.DurationMS,
		}
	}
	return view
}

func publicSkillStorageToView(status driver.PublicSkillsStorageStatus) publicSkillStorageView {
	return publicSkillStorageView{
		Driver: status.Driver, Name: status.Name, Namespace: status.Namespace,
		Configured: status.Configured, Ready: status.Ready, Phase: status.Phase,
		AccessMode: status.AccessMode, StorageClass: status.StorageClass,
		Size: status.Size, Message: status.Message,
	}
}

func skillPolicyToView(policy repo.SkillPolicy) skillPolicyView {
	return skillPolicyView{
		PolicyID: policy.PolicyID, HumanUserID: policy.HumanUserID,
		SkillName: policy.SkillName, Action: policy.Action, Reason: policy.Reason,
		CreatedBy: policy.CreatedBy, ExpiresAt: policy.ExpiresAt, CreatedAt: policy.CreatedAt,
	}
}

func validSkillScope(scope string) bool {
	switch scope {
	case repo.SkillScopeSystem, repo.SkillScopePublic, repo.SkillScopePrivate:
		return true
	default:
		return false
	}
}

func validSkillStatus(status string) bool {
	switch status {
	case repo.SkillStatusActive, repo.SkillStatusDisabled, repo.SkillStatusDeleted:
		return true
	default:
		return false
	}
}

func (s *Server) auditSkill(
	r *http.Request, action auditlog.Action, asset repo.SkillAsset, status string, count int,
) {
	target := asset.SkillID
	if target == "" {
		target = "skills"
	}
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: target,
		Metadata: auditlog.Metadata{
			PodID: asset.PodID, HumanUserID: asset.HumanUserID,
			SkillID: asset.SkillID, SkillName: asset.Name, Status: status, Count: count,
		},
	})
	if err != nil {
		log.Printf("skill_audit_failed skill=%s action=%s error=%v", asset.SkillID, action, err)
	}
}

func (s *Server) auditSkillPolicy(
	r *http.Request, action auditlog.Action, policy repo.SkillPolicy, podID, status string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: policy.PolicyID,
		Metadata: auditlog.Metadata{
			PodID: podID, HumanUserID: policy.HumanUserID,
			SkillName: policy.SkillName, Status: status,
		},
	})
	if err != nil {
		log.Printf("skill_policy_audit_failed policy=%s action=%s error=%v", policy.PolicyID, action, err)
	}
}
