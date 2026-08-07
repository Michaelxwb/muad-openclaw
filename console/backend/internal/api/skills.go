package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

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
	Body                []byte
	ExpectedName        string
	Format              string
	PlatformOverride    []string
	PlatformOverrideSet bool
	AllowOverride       bool
}

type skillAssetView struct {
	SkillID           string    `json:"skillId"`
	Name              string    `json:"name"`
	Scope             string    `json:"scope"`
	HumanUserID       string    `json:"humanUserId,omitempty"`
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
	Source            string    `json:"source"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type effectiveSkillView struct {
	Name              string                 `json:"name"`
	DisplayName       string                 `json:"displayName"`
	Effective         bool                   `json:"effective"`
	EffectiveSource   string                 `json:"effectiveSource"`
	Source            string                 `json:"source"`
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
		writeRuntimeFailure(w, r, err, errcode.RuntimeInspectPublicSkillStorage)
		return
	}
	writeJSON(w, http.StatusOK, publicSkillStorageToView(status))
}

func (s *Server) handleEnsurePublicSkillStorage(w http.ResponseWriter, r *http.Request) {
	status, err := s.drv.EnsurePublicSkillsStorage(r.Context())
	if err != nil {
		if errors.Is(err, driver.ErrInvalidPodSpec) {
			writeErr(w, r, errcode.InvalidPublicSkillStorageNotConfigured)
			return
		}
		writeRuntimeFailure(w, r, err, errcode.RuntimeCreatePublicSkillStorage)
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
		writeErr(w, r, errcode.InternalListSkills)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": skillAssetViews(assets), "total": total, "page": page, "pageSize": pageSize,
	})
}

func (s *Server) handleGetSkill(w http.ResponseWriter, r *http.Request) {
	asset, err := s.store.GetSkillAsset(r.PathValue("skillId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, skillAssetToView(asset))
}

func (s *Server) handleScanSkills(w http.ResponseWriter, r *http.Request) {
	assets, total, err := s.store.ListSkillAssets(repo.SkillAssetListFilter{})
	if err != nil {
		writeErr(w, r, errcode.InternalScanSkills)
		return
	}
	s.auditSkill(r, auditlog.ActionSkillAssetScan, repo.SkillAsset{}, "scanned", total)
	writeJSON(w, http.StatusOK, map[string]any{"scanned": total, "items": skillAssetViews(assets)})
}

func (s *Server) handleUploadPublicSkill(w http.ResponseWriter, r *http.Request) {
	if !s.publicSkillStorageReady(w, r) {
		return
	}
	upload, ok := s.readPublicSkillUpload(w, r)
	if !ok {
		return
	}
	s.skillUploadMu.Lock()
	defer s.skillUploadMu.Unlock()
	result, err := installPublicSkillBundle(upload.Body, s.cfg.SkillsDir, s.rejectPublicSkillConflict)
	if err != nil {
		if errors.Is(err, repo.ErrSkillExists) || errors.Is(err, repo.ErrInvalidSkill) {
			writeRepoError(w, r, err)
			return
		}
		log.Printf("public_skill_upload_invalid error=%v", err)
		writeErr(w, r, publicSkillBundleKey(err))
		return
	}
	result, err = applySkillPlatformOverride(result, upload)
	if err != nil {
		s.removePublicSkillAfterDelete(result.Name)
		writeErr(w, r, errcode.InvalidSkillPlatformDependency)
		return
	}
	if err := s.requireExistingSkillPlatforms(result.Platforms); err != nil {
		s.removePublicSkillAfterDelete(result.Name)
		writeErr(w, r, errcode.InvalidSkillPlatformDependencyExists)
		return
	}
	asset, podIDs, err := upsertPublicSkillAssetWithCleanup(
		result.Name,
		s.cfg.SkillsDir,
		s.store.UpsertPublicSkillAssetAndMarkPods,
		repo.SkillAsset{
			Name: result.Name, Scope: repo.SkillScopePublic, DisplayName: result.Name,
			Version: result.Version, SourcePath: result.TargetDir, ManifestHash: result.ManifestHash,
			ManifestJSON: result.ManifestJSON, EntryType: result.EntryType,
			PlatformsJSON:     mustMarshalStringSlice(result.Platforms),
			ProgressSupported: result.ProgressSupported, BrowserRequired: result.BrowserRequired,
		},
	)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.auditSkill(r, auditlog.ActionSkillAssetInstall, asset, "installed", len(podIDs))
	s.enqueueReconcileForPods(podIDs)
	writeJSON(w, http.StatusCreated, map[string]any{
		"skill": skillAssetToView(asset), "affectedPodIds": podIDs,
	})
}

// enqueueReconcileForPods 在 public Skill 变更（上传/禁用/启用/删除）后把受影响
// Pod 入队 reconcile，让 apply 链把共享 public Skill 文件同步到 worker 挂载目录，
// 无需手动「应用配置」。apply 链不重启 gateway（openclaw.json 不含 skill 列表，
// selectRestartMode=none），skill 文件经 PVC 挂载自动生效。
func (s *Server) enqueueReconcileForPods(podIDs []string) {
	for _, podID := range podIDs {
		s.enqueueReconcile(podID)
	}
}

func upsertPublicSkillAssetWithCleanup(
	skillName, skillsRoot string,
	upsert func(repo.SkillAsset) (repo.SkillAsset, []string, error),
	asset repo.SkillAsset,
) (repo.SkillAsset, []string, error) {
	created, podIDs, err := upsert(asset)
	if err != nil {
		if cleanupErr := removePublicSkillDirectory(skillsRoot, skillName); cleanupErr != nil {
			log.Printf("public_skill_upload_cleanup_failed skill=%s error=%v", skillName, cleanupErr)
		}
		return repo.SkillAsset{}, nil, err
	}
	return created, podIDs, nil
}

func (s *Server) publicSkillStorageReady(w http.ResponseWriter, r *http.Request) bool {
	status, err := s.drv.PublicSkillsStorageStatus(r.Context())
	if err != nil {
		writeRuntimeFailure(w, r, err, errcode.RuntimeInspectPublicSkillStorage)
		return false
	}
	if status.Ready {
		return true
	}
	writeErr(w, r, errcode.ConflictPublicSkillStorageNotReady)
	return false
}

func (s *Server) handlePatchSkill(w http.ResponseWriter, r *http.Request) {
	var request patchSkillRequest
	if err := decodeJSONBody(w, r, &request); err != nil || request.Status == nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	status := strings.TrimSpace(*request.Status)
	var publicDeleteName string
	if status == repo.SkillStatusDeleted {
		asset, ok := s.publicSkillDeleteTarget(w, r, r.PathValue("skillId"))
		if !ok {
			return
		}
		publicDeleteName = asset.Name
	}
	asset, podIDs, err := s.store.UpdateSkillAssetStatusAndMarkPods(
		r.PathValue("skillId"), status,
	)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	if publicDeleteName != "" {
		s.removePublicSkillAfterDelete(publicDeleteName)
	}
	s.auditSkill(r, auditlog.ActionSkillAssetUpdate, asset, asset.Status, len(podIDs))
	s.enqueueReconcileForPods(podIDs)
	writeJSON(w, http.StatusOK, map[string]any{
		"skill": skillAssetToView(asset), "affectedPodIds": podIDs,
	})
}

func (s *Server) publicSkillDeleteTarget(
	w http.ResponseWriter, r *http.Request, skillID string,
) (repo.SkillAsset, bool) {
	asset, err := s.store.GetSkillAsset(skillID)
	if err != nil {
		writeRepoError(w, r, err)
		return repo.SkillAsset{}, false
	}
	if asset.Scope != repo.SkillScopePublic {
		writeRepoError(w, r, repo.ErrInvalidSkill)
		return repo.SkillAsset{}, false
	}
	return asset, true
}

func (s *Server) removePublicSkillAfterDelete(skillName string) {
	if err := removePublicSkillDirectory(s.cfg.SkillsDir, skillName); err != nil {
		log.Printf("public_skill_delete_cleanup_failed skill=%s error=%v", skillName, err)
	}
}

func (s *Server) installPrivateSkillBundleForUser(
	bundle []byte, humanUserID, expectedName string, allowOverride bool,
) (privateSkillInstallResult, error) {
	return installPrivateSkillBundle(
		bundle, s.cfg.SkillsDir, humanUserID, expectedName,
		func(name string) error {
			return s.rejectPrivateSkillConflict(name, humanUserID, allowOverride)
		},
	)
}

func (s *Server) removePrivateSkillAfterDelete(humanUserID, skillName string) {
	root, err := resolvePrivateSkillRoot(s.cfg.SkillsDir, humanUserID)
	if err != nil {
		log.Printf("private_skill_delete_cleanup_failed user=%s skill=%s error=%v", humanUserID, skillName, err)
		return
	}
	if err := removePublicSkillDirectory(root, skillName); err != nil {
		log.Printf("private_skill_delete_cleanup_failed user=%s skill=%s error=%v", humanUserID, skillName, err)
	}
}

func (s *Server) handleListHumanUserSkills(w http.ResponseWriter, r *http.Request) {
	filter := repo.EffectiveSkillFilter{
		Query:  strings.TrimSpace(r.URL.Query().Get("q")),
		Status: strings.TrimSpace(r.URL.Query().Get("status")),
	}
	skills, total, err := s.store.ResolveEffectiveSkills(r.PathValue("humanUserId"), filter)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": effectiveSkillViews(skills), "total": total})
}

func (s *Server) handleCreateSkillPolicy(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	var request createSkillPolicyRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
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
		writeRepoError(w, r, err)
		return
	}
	s.auditSkillPolicy(r, auditlog.ActionSkillPolicyCreate, created, podID, "created")
	// Auto-sync: policy is part of the runtime contract; enqueue reconcile so the
	// apply chain propagates it to the worker without a manual「应用配置」.
	s.enqueueReconcile(podID)
	writeJSON(w, http.StatusCreated, skillPolicyToView(created))
}

type ingestPrivateSkillRequest struct {
	AgentID      string `json:"agentId"`
	BundleFormat string `json:"bundleFormat"`
	BundleBase64 string `json:"bundle"`
}

// handleIngestPrivateSkill is the worker-side private skill upload path
// (POST /internal/v1/skills/private/ingest, pod service token authenticated).
// skill-upload packages a user-authored staging skill via `installer export`,
// POSTs it here; the console validates with the existing skill_bundle pipeline,
// records the private skill asset, then syncs it directly to the workspace
// (no config_generation bump, no gateway restart — the openclaw watcher picks
// the installed files up).
func (s *Server) handleIngestPrivateSkill(w http.ResponseWriter, r *http.Request) {
	var request ingestPrivateSkillRequest
	if err := decodeJSONBodyLimit(w, r, &request, ingestJSONBodyLimit(s.cfg.SkillMaxUploadBundleBytes)); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	request.AgentID = strings.TrimSpace(request.AgentID)
	request.BundleFormat = strings.TrimSpace(request.BundleFormat)
	if request.AgentID == "" || request.BundleBase64 == "" {
		writeErr(w, r, errcode.InvalidAgentBundleRequired)
		return
	}
	if request.BundleFormat != "tar.gz" && request.BundleFormat != "zip" {
		writeErr(w, r, errcode.InvalidBundleFormat)
		return
	}
	bundle, err := base64.StdEncoding.DecodeString(request.BundleBase64)
	if err != nil {
		writeErr(w, r, errcode.InvalidBundleEncoding)
		return
	}
	if int64(len(bundle)) > s.cfg.SkillMaxUploadBundleBytes {
		writeErr(w, r, errcode.InvalidSkillBundle)
		return
	}
	user, err := s.store.GetHumanUserByAgentID(request.AgentID)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.skillUploadMu.Lock()
	defer s.skillUploadMu.Unlock()
	result, err := installPrivateSkillBundle(
		bundle, s.cfg.SkillsDir, user.HumanUserID, "",
		func(name string) error { return s.rejectPrivateSkillConflict(name, user.HumanUserID, false) },
	)
	if err != nil {
		if errors.Is(err, repo.ErrSkillExists) || errors.Is(err, repo.ErrInvalidSkill) {
			writeRepoError(w, r, err)
			return
		}
		log.Printf("private_skill_ingest_invalid user=%s error=%s",
			user.HumanUserID, auditlog.RedactDiagnostic(err.Error()))
		writeErr(w, r, publicSkillBundleKey(err))
		return
	}
	asset, err := s.store.CreateSkillAsset(repo.SkillAsset{
		Name: result.Name, Scope: repo.SkillScopePrivate, HumanUserID: user.HumanUserID,
		DisplayName: result.Name, Version: result.Version,
		SourcePath: result.TargetDir, ManifestHash: result.ManifestHash,
		ManifestJSON: result.ManifestJSON, EntryType: result.EntryType,
		PlatformsJSON:     mustMarshalStringSlice(result.Platforms),
		ProgressSupported: result.ProgressSupported, BrowserRequired: result.BrowserRequired,
		Source: repo.SkillSourceUser,
	})
	if err != nil {
		s.removePrivateSkillAfterDelete(user.HumanUserID, result.Name)
		writeRepoError(w, r, err)
		return
	}
	// Direct sync without a config generation bump: the skill is installed to the
	// workspace now; the watcher discovers it without a gateway restart. A sync
	// failure leaves the asset recorded for a later reconcile/reload to retry.
	if s.skillSyncer != nil {
		syncCtx, cancel := context.WithTimeout(r.Context(), podRuntimeOpTimeout)
		defer cancel()
		if err := s.skillSyncer.SyncPod(syncCtx, user.PodID); err != nil {
			log.Printf("private_skill_ingest_sync_failed user=%s skill=%s error=%v",
				user.HumanUserID, result.Name, auditlog.RedactDiagnostic(err.Error()))
		}
	}
	s.auditSkill(r, auditlog.ActionSkillAssetInstall, asset, "ingested", 1)
	writeJSON(w, http.StatusOK, map[string]any{"skill": skillAssetToView(asset)})
}

// ingestJSONBodyLimit is the JSON body cap for the private-skill ingest
// endpoint: enough to hold the base64 encoding of the largest allowed bundle
// plus a 1 MiB slack for the surrounding JSON fields. Bundles that are merely
// a little over the limit therefore decode successfully and are then rejected
// by the explicit size check with a clear error, rather than surfacing as a
// generic "request body too large".
func ingestJSONBodyLimit(maxBundleBytes int64) int64 {
	return (maxBundleBytes+2)/3*4 + 1<<20
}

func (s *Server) handleUploadPrivateSkill(w http.ResponseWriter, r *http.Request) {
	user, pod, ok := s.privateSkillTarget(w, r, r.PathValue("humanUserId"))
	if !ok {
		return
	}
	upload, ok := s.readPrivateSkillUpload(w, r)
	if !ok {
		return
	}
	if upload.AllowOverride && strings.TrimSpace(upload.ExpectedName) == "" {
		writeErr(w, r, errcode.InvalidPublicSkillOverrideName)
		return
	}
	s.skillUploadMu.Lock()
	defer s.skillUploadMu.Unlock()
	result, err := s.installPrivateSkillBundleForUser(
		upload.Body, user.HumanUserID, upload.ExpectedName, upload.AllowOverride,
	)
	if err != nil {
		if errors.Is(err, repo.ErrSkillExists) || errors.Is(err, repo.ErrInvalidSkill) {
			writeRepoError(w, r, err)
			return
		}
		log.Printf("private_skill_upload_invalid user=%s error=%v", user.HumanUserID, err)
		writeErr(w, r, publicSkillBundleKey(err))
		return
	}
	result, err = applySkillPlatformOverride(result, upload)
	if err != nil {
		s.removePrivateSkillAfterDelete(user.HumanUserID, result.Name)
		writeErr(w, r, errcode.InvalidSkillPlatformDependency)
		return
	}
	if err := s.requireExistingSkillPlatforms(result.Platforms); err != nil {
		s.removePrivateSkillAfterDelete(user.HumanUserID, result.Name)
		writeErr(w, r, errcode.InvalidSkillPlatformDependencyExists)
		return
	}
	policy := privateUploadPolicy(upload, user.HumanUserID, result.Name, actorFrom(r.Context()))
	asset, policyCreated, err := s.store.CreatePrivateSkillAssetAndPolicyAndMarkPod(repo.SkillAsset{
		Name: result.Name, Scope: repo.SkillScopePrivate, HumanUserID: user.HumanUserID,
		DisplayName: result.Name, Version: result.Version,
		SourcePath: result.TargetDir, ManifestHash: result.ManifestHash,
		ManifestJSON: result.ManifestJSON, EntryType: result.EntryType,
		PlatformsJSON:     mustMarshalStringSlice(result.Platforms),
		ProgressSupported: result.ProgressSupported, BrowserRequired: result.BrowserRequired,
	}, policy)
	if err != nil {
		s.removePrivateSkillAfterDelete(user.HumanUserID, result.Name)
		writeRepoError(w, r, err)
		return
	}
	s.auditSkill(r, auditlog.ActionSkillAssetInstall, asset, "installed", 1)
	if policyCreated != nil {
		s.auditSkillPolicy(r, auditlog.ActionSkillPolicyCreate, *policyCreated, pod.PodID, "created")
	}
	// Auto-sync: mark pending alone does not reach the worker; enqueue reconcile so
	// the apply chain runs SyncPod (installer → workspace) without a gateway restart.
	s.enqueueReconcile(pod.PodID)
	writeJSON(w, http.StatusCreated, map[string]any{"skill": skillAssetToView(asset)})
}

func privateUploadPolicy(
	upload skillBundleUpload, humanUserID, skillName, actor string,
) *repo.SkillPolicy {
	if !upload.AllowOverride {
		return nil
	}
	return &repo.SkillPolicy{
		HumanUserID: humanUserID, SkillName: skillName,
		Action: repo.SkillPolicyAllowOverride, Reason: "console", CreatedBy: actor,
	}
}

func (s *Server) handleDeletePrivateSkill(w http.ResponseWriter, r *http.Request) {
	user, pod, ok := s.privateSkillTarget(w, r, r.PathValue("humanUserId"))
	if !ok {
		return
	}
	asset, err := s.store.GetSkillAsset(r.PathValue("skillId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	if asset.Scope != repo.SkillScopePrivate || asset.HumanUserID != user.HumanUserID {
		writeRepoError(w, r, repo.ErrNotFound)
		return
	}
	deleted, err := s.store.DeletePrivateSkillAssetAndMarkPod(asset.SkillID, user.HumanUserID)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.removePrivateSkillAfterDelete(user.HumanUserID, asset.Name)
	s.auditSkill(r, auditlog.ActionSkillAssetDelete, deleted, "deleted", 1)
	// Auto-sync: enqueue reconcile so the apply chain removes the Skill from the
	// workspace (SyncPod → installer) and clears skills_pending without a restart.
	s.enqueueReconcile(pod.PodID)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "skillId": asset.SkillID})
}

func (s *Server) handleDeleteSkillPolicy(w http.ResponseWriter, r *http.Request) {
	if _, err := s.store.GetHumanUser(r.PathValue("humanUserId")); err != nil {
		writeRepoError(w, r, err)
		return
	}
	podID, err := s.store.DeleteSkillPolicyForHumanUserAndMarkPod(
		r.PathValue("policyId"), r.PathValue("humanUserId"),
	)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	s.auditSkillPolicy(r, auditlog.ActionSkillPolicyDelete, repo.SkillPolicy{
		PolicyID: r.PathValue("policyId"), HumanUserID: r.PathValue("humanUserId"),
	}, podID, "deleted")
	s.enqueueReconcile(podID)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "policyId": r.PathValue("policyId")})
}

func (s *Server) privateSkillTarget(
	w http.ResponseWriter, r *http.Request, humanUserID string,
) (repo.HumanUser, repo.Pod, bool) {
	user, err := s.store.GetHumanUser(humanUserID)
	if err != nil {
		writeRepoError(w, r, err)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	pod, err := s.store.GetPod(user.PodID)
	if err != nil {
		writeRepoError(w, r, err)
		return repo.HumanUser{}, repo.Pod{}, false
	}
	return user, pod, true
}

func (s *Server) readPrivateSkillUpload(w http.ResponseWriter, r *http.Request) (skillBundleUpload, bool) {
	return readSkillBundleUpload(w, r, s.cfg.SkillMaxUploadBundleBytes, ".tar.gz", ".zip")
}

func (s *Server) readPublicSkillUpload(w http.ResponseWriter, r *http.Request) (skillBundleUpload, bool) {
	return readSkillBundleUpload(w, r, s.cfg.SkillMaxUploadBundleBytes, ".tar.gz", ".zip")
}

func readSkillBundleUpload(
	w http.ResponseWriter, r *http.Request, maxBytes int64, allowedExts ...string,
) (skillBundleUpload, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1024*1024)
	if err := r.ParseMultipartForm(maxBytes); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return skillBundleUpload{}, false
	}
	file, header, err := r.FormFile("bundle")
	if err != nil {
		writeErr(w, r, errcode.InvalidSkillBundle)
		return skillBundleUpload{}, false
	}
	defer file.Close()
	format, ok := skillBundleFormat(header.Filename, allowedExts)
	if header.Size > maxBytes || !ok {
		writeErr(w, r, errcode.InvalidSkillBundle)
		return skillBundleUpload{}, false
	}
	var buffer bytes.Buffer
	if _, err := buffer.ReadFrom(file); err != nil || buffer.Len() == 0 ||
		int64(buffer.Len()) > maxBytes {
		writeErr(w, r, errcode.InvalidSkillBundle)
		return skillBundleUpload{}, false
	}
	platforms, platformsSet, ok := readSkillUploadPlatforms(w, r)
	if !ok {
		return skillBundleUpload{}, false
	}
	allowOverride, ok := readSkillUploadAllowOverride(w, r)
	if !ok {
		return skillBundleUpload{}, false
	}
	return skillBundleUpload{
		Body: buffer.Bytes(), ExpectedName: strings.TrimSpace(r.FormValue("expectedName")),
		Format: format, PlatformOverride: platforms, PlatformOverrideSet: platformsSet,
		AllowOverride: allowOverride,
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

// publicSkillBundleKey maps a bundle validation error to a stable error-code
// whose localized message is user-friendly. Unknown errors fall back to the
// generic invalid-skill-bundle code.
func publicSkillBundleKey(err error) int {
	message := err.Error()
	switch {
	case strings.Contains(message, "OpenClaw frontmatter name and description"):
		return errcode.SkillBundleFrontmatter
	case strings.Contains(message, "must match SKILL.md frontmatter name"):
		return errcode.SkillBundleNameMismatch
	case strings.Contains(message, "must contain a SKILL.md") ||
		strings.Contains(message, "must contain SKILL.md"):
		return errcode.SkillBundleNoSkillMd
	case strings.Contains(message, "multiple top-level Skill roots"):
		return errcode.SkillBundleMultiRoot
	case strings.Contains(message, "invalid skill name"):
		return errcode.SkillBundleInvalidName
	case strings.Contains(message, "invalid platform dependency"):
		return errcode.SkillBundleInvalidPlatform
	case strings.Contains(message, "decode Skill manifest") ||
		strings.Contains(message, "invalid Skill manifest"):
		return errcode.SkillBundleInvalidManifest
	case strings.Contains(message, "parent path") ||
		strings.Contains(message, "absolute path") ||
		strings.Contains(message, "invalid path") ||
		strings.Contains(message, "escapes"):
		return errcode.SkillBundleUnsafePath
	case strings.Contains(message, "link"):
		return errcode.SkillBundleLink
	default:
		return errcode.InvalidSkillBundle
	}
}

func (s *Server) rejectPrivateSkillConflict(
	name, humanUserID string, requestedAllowOverride bool,
) error {
	assets, err := s.store.ListSkillAssetsByName(name)
	if err != nil {
		return err
	}
	allowOverride := requestedAllowOverride
	if !allowOverride {
		allowOverride, err = s.hasAllowOverridePolicy(humanUserID, name)
		if err != nil {
			return err
		}
	}
	for _, asset := range assets {
		if asset.Scope == repo.SkillScopeSystem {
			return repo.ErrInvalidSkill
		}
		if asset.Scope == repo.SkillScopePublic && !allowOverride {
			return repo.ErrSkillExists
		}
		if asset.Scope == repo.SkillScopePrivate && asset.HumanUserID == strings.TrimSpace(humanUserID) {
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
		if asset.Scope == repo.SkillScopePublic {
			return repo.ErrSkillExists
		}
	}
	return nil
}

func (s *Server) requireExistingSkillPlatforms(platforms []string) error {
	for _, platform := range platforms {
		if _, err := s.store.GetPlatformConfig(platform); err != nil {
			return err
		}
	}
	return nil
}

func readSkillUploadPlatforms(
	w http.ResponseWriter, r *http.Request,
) ([]string, bool, bool) {
	raw := strings.TrimSpace(r.FormValue("platforms"))
	if raw == "" {
		return nil, false, true
	}
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		writeErr(w, r, errcode.InvalidSkillPlatforms)
		return nil, false, false
	}
	platforms, err := normalizeUploadPlatforms(values)
	if err != nil {
		writeErr(w, r, errcode.InvalidSkillPlatforms)
		return nil, false, false
	}
	return platforms, true, true
}

func readSkillUploadAllowOverride(w http.ResponseWriter, r *http.Request) (bool, bool) {
	raw := strings.TrimSpace(r.FormValue("allowOverride"))
	if raw == "" {
		return false, true
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		writeErr(w, r, errcode.InvalidAllowOverride)
		return false, false
	}
	return value, true
}

func normalizeUploadPlatforms(values []string) ([]string, error) {
	platforms := make([]string, 0, len(values))
	for _, value := range values {
		platform := normalizePlatformName(value)
		if platform == "" {
			return nil, repo.ErrInvalidPlatform
		}
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)
	return slices.Compact(platforms), nil
}

func applySkillPlatformOverride(
	result privateSkillInstallResult, upload skillBundleUpload,
) (privateSkillInstallResult, error) {
	if !upload.PlatformOverrideSet {
		return result, nil
	}
	result.Platforms = copySkillPlatforms(upload.PlatformOverride)
	manifestJSON, err := replaceSkillManifestPlatforms(result.ManifestJSON, result.Platforms)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	result.ManifestJSON = manifestJSON
	return result, nil
}

func replaceSkillManifestPlatforms(raw string, platforms []string) (string, error) {
	var manifest map[string]any
	if err := json.Unmarshal([]byte(raw), &manifest); err != nil || manifest == nil {
		return "", repo.ErrInvalidSkill
	}
	manifest["platforms"] = copySkillPlatforms(platforms)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
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
	encoded, err := json.Marshal(copySkillPlatforms(values))
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

func copySkillPlatforms(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return append([]string(nil), values...)
}

func skillAssetFilterFromRequest(
	w http.ResponseWriter, r *http.Request,
) (repo.SkillAssetListFilter, int, int, bool) {
	page, pageSize := parsePodPagination(r)
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if scope != "" && !validSkillScope(scope) {
		writeErr(w, r, errcode.InvalidSkillScope)
		return repo.SkillAssetListFilter{}, 0, 0, false
	}
	if status != "" && !validSkillStatus(status) {
		writeErr(w, r, errcode.InvalidSkillStatus)
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
		HumanUserID: asset.HumanUserID, DisplayName: asset.DisplayName,
		Version: asset.Version, Status: asset.Status, SourcePath: asset.SourcePath,
		ManifestHash: asset.ManifestHash, ManifestJSON: asset.ManifestJSON,
		EntryType: asset.EntryType, PlatformsJSON: asset.PlatformsJSON,
		BrowserRequired: asset.BrowserRequired, ProgressSupported: asset.ProgressSupported,
		SystemProtected: asset.SystemProtected, Source: asset.Source,
		CreatedAt: asset.CreatedAt, UpdatedAt: asset.UpdatedAt,
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
		EffectiveSource: skill.EffectiveSource, Source: skill.Source,
		Status: skill.Status, Version: skill.Version,
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
	// Internal ingest (pod service token) has no admin actor in context; audit as
	// the Pod so skill installs via the agent still leave an audit trail.
	actor := auditlog.AdminActor(actorFrom(r.Context()))
	if pod, ok := podFromContext(r.Context()); ok {
		actor = auditlog.PodActor(pod.PodID)
	}
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: actor, Action: action, Target: target,
		Metadata: auditlog.Metadata{
			HumanUserID: asset.HumanUserID,
			SkillID:     asset.SkillID, SkillName: asset.Name, Status: status, Count: count,
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
