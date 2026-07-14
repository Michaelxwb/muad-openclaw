package api

import (
	"net/http"
)

func (s *Server) registerAdminRoutes(mux *http.ServeMux) {
	s.registerPodRoutes(mux)
	s.registerHumanUserRoutes(mux)
	s.registerPlatformRoutes(mux)
	s.registerExistingSettingsRoutes(mux)
}

func (s *Server) registerPodRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/containers", s.handleCreatePod)
	mux.HandleFunc("GET /api/v1/containers", s.handleListPods)
	mux.HandleFunc("GET /api/v1/containers/{podId}", s.handleGetPod)
	mux.HandleFunc("PATCH /api/v1/containers/{podId}", s.handlePatchPod)
	mux.HandleFunc("DELETE /api/v1/containers/{podId}", s.handleDeletePod)
	mux.HandleFunc("PUT /api/v1/containers/{podId}/channels", s.handlePutPodChannels)
	mux.HandleFunc("POST /api/v1/containers/{podId}/apply-config", s.handleApplyPodConfig)
	mux.HandleFunc("POST /api/v1/containers/{podId}/actions/{action}", s.handleAction)
	mux.HandleFunc("GET /api/v1/containers/{podId}/logs", s.handleLogs)
	mux.HandleFunc("GET /api/v1/containers/{podId}/qrcode", s.handleQRCode)
	mux.HandleFunc("POST /api/v1/containers/{podId}/upgrade", s.handleUpgrade)
	mux.HandleFunc("GET /api/v1/containers/{podId}/resources", s.handleGetPodResources)
	mux.HandleFunc("PUT /api/v1/containers/{podId}/resources", s.handleSetPodResources)
	mux.HandleFunc("POST /api/v1/containers/{podId}/service-token/rotate", s.handleRotatePodServiceToken)
}

func (s *Server) registerHumanUserRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/human-users", s.handleListAllHumanUsers)
	mux.HandleFunc("GET /api/v1/containers/{podId}/human-users", s.handleListHumanUsers)
	mux.HandleFunc("POST /api/v1/containers/{podId}/human-users", s.handleCreateHumanUser)
	mux.HandleFunc("GET /api/v1/human-users/{humanUserId}", s.handleGetHumanUser)
	mux.HandleFunc("PATCH /api/v1/human-users/{humanUserId}", s.handlePatchHumanUser)
	mux.HandleFunc("DELETE /api/v1/human-users/{humanUserId}", s.handleDeleteHumanUser)
	mux.HandleFunc("POST /api/v1/human-users/{humanUserId}/identities", s.handleCreateIdentity)
	mux.HandleFunc("PATCH /api/v1/human-users/{humanUserId}/identities/{identityId}", s.handlePatchIdentity)
	mux.HandleFunc("DELETE /api/v1/human-users/{humanUserId}/identities/{identityId}", s.handleDeleteIdentity)
	mux.HandleFunc("POST /api/v1/human-users/{humanUserId}/binding-codes", s.handleCreateBindingCode)
	mux.HandleFunc("GET /api/v1/human-users/{humanUserId}/binding-codes", s.handleListBindingCodes)
	mux.HandleFunc("DELETE /api/v1/human-users/{humanUserId}/binding-codes/{bindingCodeId}", s.handleRevokeBindingCode)
}

func (s *Server) registerPlatformRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/platforms", s.handleListPlatforms)
	mux.HandleFunc("POST /api/v1/platforms", s.handleCreatePlatform)
	mux.HandleFunc("PATCH /api/v1/platforms/{platform}", s.handlePatchPlatform)
	mux.HandleFunc("DELETE /api/v1/platforms/{platform}", s.handleDeletePlatform)
	mux.HandleFunc("GET /api/v1/human-users/{humanUserId}/platform-credentials", s.handleListPlatformCredentials)
	mux.HandleFunc("PUT /api/v1/human-users/{humanUserId}/platform-credentials/{platform}", s.handlePutPlatformCredential)
	mux.HandleFunc("DELETE /api/v1/human-users/{humanUserId}/platform-credentials/{platform}", s.handleDeletePlatformCredential)
}

func (s *Server) registerExistingSettingsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/llm/models", s.handleListLLMModels)
	mux.HandleFunc("POST /api/v1/llm/models/batch", s.handleCreateLLMModels)
	mux.HandleFunc("POST /api/v1/llm/models/test", s.handleBatchTestLLMModels)
	mux.HandleFunc("GET /api/v1/skills", s.handleListSkills)
	mux.HandleFunc("GET /api/v1/skills/public-storage", s.handleGetPublicSkillStorage)
	mux.HandleFunc("POST /api/v1/skills/public-storage", s.handleEnsurePublicSkillStorage)
	mux.HandleFunc("POST /api/v1/skills/scan", s.handleScanSkills)
	mux.HandleFunc("GET /api/v1/skills/{skillId}", s.handleGetSkill)
	mux.HandleFunc("POST /api/v1/skills/public", s.handleUploadPublicSkill)
	mux.HandleFunc("PATCH /api/v1/skills/{skillId}", s.handlePatchSkill)
	mux.HandleFunc("POST /api/v1/skills/reload", s.handleSkillsReload)
	mux.HandleFunc("GET /api/v1/human-users/{humanUserId}/skills", s.handleListHumanUserSkills)
	mux.HandleFunc("POST /api/v1/human-users/{humanUserId}/skills/private", s.handleUploadPrivateSkill)
	mux.HandleFunc("DELETE /api/v1/human-users/{humanUserId}/skills/private/{skillId}", s.handleDeletePrivateSkill)
	mux.HandleFunc("POST /api/v1/human-users/{humanUserId}/skill-policies", s.handleCreateSkillPolicy)
	mux.HandleFunc("DELETE /api/v1/human-users/{humanUserId}/skill-policies/{policyId}", s.handleDeleteSkillPolicy)
	mux.HandleFunc("GET /api/v1/skill-executions", s.handleListSkillExecutions)
	mux.HandleFunc("GET /api/v1/audit", s.handleAuditQuery)
	mux.HandleFunc("GET /api/v1/alerts", s.handleAlerts)
	mux.HandleFunc("GET /api/v1/settings/resources", s.handleGetResources)
	mux.HandleFunc("PUT /api/v1/settings/resources", s.handleSetResources)
}

func (s *Server) registerInternalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/v1/bindings/activate", s.handleActivateBinding)
	mux.HandleFunc("POST /internal/v1/session-credentials/resolve", s.handleResolveSessionCredential)
	mux.HandleFunc("POST /internal/v1/skill-executions", s.handleUpsertSkillExecution)
}

func (s *Server) handleNotImplemented(w http.ResponseWriter, _ *http.Request) {
	writeErr(w, http.StatusNotImplemented, codeDependencyUnavailable, "endpoint not implemented")
}
