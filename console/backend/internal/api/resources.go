package api

import (
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const maxRuntimeConcurrency = 1000

var (
	memPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?[bkmgBKMG]$`)
	cpuPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
)

type resourceFieldsRequest struct {
	MemLimit      *string `json:"memLimit"`
	CPULimit      *string `json:"cpuLimit"`
	RestartPolicy *string `json:"restartPolicy"`
}

type podResourceRequest struct {
	resourceFieldsRequest
	MaxSkillConcurrency    *int `json:"maxSkillConcurrency"`
	MaxBrowserConcurrency  *int `json:"maxBrowserConcurrency"`
	MaxLongTaskConcurrency *int `json:"maxLongTaskConcurrency"`
}

type resourceValues struct {
	MemLimit               string `json:"memLimit"`
	CPULimit               string `json:"cpuLimit"`
	RestartPolicy          string `json:"restartPolicy"`
	MaxSkillConcurrency    int    `json:"maxSkillConcurrency"`
	MaxBrowserConcurrency  int    `json:"maxBrowserConcurrency"`
	MaxLongTaskConcurrency int    `json:"maxLongTaskConcurrency"`
}

func validateResourceRequest(request resourceFieldsRequest) error {
	if request.MemLimit != nil {
		value := strings.TrimSpace(*request.MemLimit)
		if value != "" {
			// 裸数字按 GiB 解释；归一化为 "Ng" 后按既有格式校验。
			normalized := normalizeMemLimit(value)
			if !memPattern.MatchString(normalized) {
				return newInputValidationError(
					errcode.InvalidResourceLimits,
					"memLimit 必须为空、裸数字 GiB，或带单位 b/k/m/g，例如 2、512m、2g、2.5g",
					"memLimit must be empty, a bare GiB number, or use unit b/k/m/g, for example 2, 512m, 2g, 2.5g",
				)
			}
			if _, err := driver.MemoryLimitMiB(normalized); err != nil {
				return wrapInputValidationError(
					errcode.InvalidResourceLimits, err,
					"memLimit 必须大于 0，请填写有效的内存上限",
					"memLimit must be greater than 0; provide a valid memory limit",
				)
			}
		}
	}
	if request.CPULimit != nil {
		value := strings.TrimSpace(*request.CPULimit)
		parsed, err := strconv.ParseFloat(value, 64)
		if value != "" && (!cpuPattern.MatchString(value) || err != nil || parsed <= 0) {
			return newInputValidationError(
				errcode.InvalidResourceLimits,
				"cpuLimit 必须为空或正数，例如 1、1.5",
				"cpuLimit must be empty or a positive number, for example 1 or 1.5",
			)
		}
	}
	if request.RestartPolicy != nil {
		value := strings.TrimSpace(*request.RestartPolicy)
		if value != "" && !driver.IsValidRestartPolicy(value) {
			return newInputValidationError(
				errcode.InvalidResourceLimits,
				"restartPolicy 只能为空或为 no、on-failure、always、unless-stopped",
				"restartPolicy must be empty or one of no, on-failure, always, unless-stopped",
			)
		}
	}
	return nil
}

// normalizeMemLimit 把裸数字（按 GiB 解释）归一化为 "Ng"，带单位的值原样返回。
func normalizeMemLimit(value string) string {
	value = strings.TrimSpace(value)
	if cpuPattern.MatchString(value) { // ^[0-9]+(\.[0-9]+)?$ 纯数字
		return value + "g"
	}
	return value
}

func normalizeMemLimitPtr(field *string) *string {
	if field == nil {
		return nil
	}
	normalized := normalizeMemLimit(*field)
	return &normalized
}

func validateConcurrency(request podResourceRequest) error {
	fields := []struct {
		name  string
		value *int
	}{
		{"maxSkillConcurrency", request.MaxSkillConcurrency},
		{"maxBrowserConcurrency", request.MaxBrowserConcurrency},
		{"maxLongTaskConcurrency", request.MaxLongTaskConcurrency},
	}
	for _, field := range fields {
		if field.value != nil && (*field.value < 0 || *field.value > maxRuntimeConcurrency) {
			return newInputValidationError(
				errcode.InvalidResourceLimits,
				field.name+" 必须为 0（继承）或 1-1000 之间的整数",
				field.name+" must be 0 (inherit) or an integer between 1 and 1000",
			)
		}
	}
	return nil
}

func validatePodResourceRequest(request podResourceRequest) error {
	if err := validateResourceRequest(request.resourceFieldsRequest); err != nil {
		return err
	}
	return validateConcurrency(request)
}

func (s *Server) handleGetResources(w http.ResponseWriter, r *http.Request) {
	global, configured, err := s.readGlobalResources()
	if err != nil {
		writeErr(w, r, errcode.InternalReadResourceConfig)
		return
	}
	effective := driver.ResolveResourceSpec(driver.ResourceSpec{}, global, s.resourceFallback())
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": configured, "memLimit": effective.MemLimit,
		"cpuLimit": effective.CPULimit, "restartPolicy": effective.RestartPolicy,
		"globalOverrides": toResourceValues(global),
		"runtimeDefaults": toResourceValues(s.resourceFallback()),
		"effective":       toResourceValues(effective),
	})
}

func (s *Server) handleSetResources(w http.ResponseWriter, r *http.Request) {
	current, _, err := s.readGlobalResources()
	if err != nil {
		writeErr(w, r, errcode.InternalReadResourceConfig)
		return
	}
	var request podResourceRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidResourceLimits)
		return
	}
	request.MemLimit = normalizeMemLimitPtr(request.MemLimit)
	if err := validatePodResourceRequest(request); err != nil {
		writeInputValidationError(w, r, errcode.InvalidResourceLimits, err)
		return
	}
	next := applyGlobalRequest(current, request)
	podIDs, err := s.store.SaveResourcesAndMarkPods(repo.ResourceConfig{
		MemLimit: next.MemLimit, CPULimit: next.CPULimit, RestartPolicy: next.RestartPolicy,
		MaxSkillConcurrency: next.MaxSkillConcurrency, MaxBrowserConcurrency: next.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: next.MaxLongTaskConcurrency,
	},
		current.MemLimit != next.MemLimit, current.CPULimit != next.CPULimit,
		current.RestartPolicy != next.RestartPolicy,
		current.MaxSkillConcurrency != next.MaxSkillConcurrency,
		current.MaxBrowserConcurrency != next.MaxBrowserConcurrency,
		current.MaxLongTaskConcurrency != next.MaxLongTaskConcurrency,
	)
	if err != nil {
		writeErr(w, r, errcode.InternalSaveResourceConfig)
		return
	}
	for _, podID := range podIDs {
		s.enqueueReconcile(podID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "affectedPodIds": podIDs})
}

func (s *Server) handleGetPodResources(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	view, err := s.podResourceView(pod)
	if err != nil {
		writeErr(w, r, errcode.InternalResolvePodResources)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleSetPodResources(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	var request podResourceRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidResourceLimits)
		return
	}
	request.MemLimit = normalizeMemLimitPtr(request.MemLimit)
	if err := validatePodResourceRequest(request); err != nil {
		writeInputValidationError(w, r, errcode.InvalidResourceLimits, err)
		return
	}
	next := applyPodResourceRequest(pod, request)
	resourceChanged, concurrencyChanged := resourceChanges(pod, next)
	if !resourceChanged && !concurrencyChanged {
		view, _ := s.podResourceView(pod)
		writeJSON(w, http.StatusOK, view)
		return
	}
	generation, err := s.store.UpdatePodResources(pod.PodID, next)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	// mem/cpu/restart only take effect on container Create. Always enqueue reconcile for
	// concurrency DTO changes; for cgroup fields surface requiresPodRestart so clients
	// (or operators) recreate via upgrade/restart path instead of false "applied".
	s.enqueueReconcile(pod.PodID)
	s.auditResourceUpdate(r, pod.PodID, generation)
	updated, err := s.store.GetPod(pod.PodID)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	view, err := s.podResourceView(updated)
	if err != nil {
		writeErr(w, r, errcode.InternalResolvePodResources)
		return
	}
	view["requiresPodRestart"] = resourceChanged
	view["runtimeConfigChanged"] = concurrencyChanged
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) podResourceView(pod repo.Pod) (map[string]any, error) {
	global, _, err := s.readGlobalResources()
	if err != nil {
		return nil, err
	}
	overrides := podResourceSpec(pod)
	effective := driver.ResolveResourceSpec(overrides, global, s.resourceFallback())
	threshold, err := driver.MemoryLimitMiB(effective.MemLimit)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"podId": pod.PodID, "overrides": toResourceValues(overrides),
		"globalDefaults":  toResourceValues(global),
		"runtimeDefaults": toResourceValues(s.resourceFallback()),
		"effective":       toResourceValues(effective), "memoryAlertThresholdMiB": threshold * 85 / 100,
		"configGeneration": pod.ConfigGeneration, "appliedGeneration": pod.AppliedGeneration,
		"lastApplyStatus": pod.LastApplyStatus,
	}, nil
}

func (s *Server) readGlobalResources() (driver.ResourceSpec, bool, error) {
	global, err := s.store.GetResourceGlobal()
	if errors.Is(err, repo.ErrNotFound) {
		return driver.ResourceSpec{}, false, nil
	}
	if err != nil {
		return driver.ResourceSpec{}, false, err
	}
	return driver.ResourceSpec{
		MemLimit: global.MemLimit, CPULimit: global.CPULimit, RestartPolicy: global.RestartPolicy,
		MaxSkillConcurrency: global.MaxSkillConcurrency, MaxBrowserConcurrency: global.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: global.MaxLongTaskConcurrency,
	}, true, nil
}

func (s *Server) resourceFallback() driver.ResourceSpec {
	if s.cfg == nil {
		return driver.ResourceSpec{}
	}
	return driver.ResourceSpec{
		MemLimit: s.cfg.RuntimeDefaults.MemLimit, CPULimit: s.cfg.RuntimeDefaults.CPULimit,
		RestartPolicy:          s.cfg.RuntimeDefaults.RestartPolicy,
		MaxSkillConcurrency:    s.cfg.RuntimeDefaults.MaxSkillConcurrency,
		MaxBrowserConcurrency:  s.cfg.RuntimeDefaults.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: s.cfg.RuntimeDefaults.MaxLongTaskConcurrency,
	}
}

func applyGlobalRequest(current driver.ResourceSpec, request podResourceRequest) driver.ResourceSpec {
	next := current
	applyStringPointer(&next.MemLimit, request.MemLimit)
	applyStringPointer(&next.CPULimit, request.CPULimit)
	applyStringPointer(&next.RestartPolicy, request.RestartPolicy)
	applyIntPointer(&next.MaxSkillConcurrency, request.MaxSkillConcurrency)
	applyIntPointer(&next.MaxBrowserConcurrency, request.MaxBrowserConcurrency)
	applyIntPointer(&next.MaxLongTaskConcurrency, request.MaxLongTaskConcurrency)
	return next
}

func applyPodResourceRequest(pod repo.Pod, request podResourceRequest) repo.PodResourceUpdate {
	next := repo.PodResourceUpdate{
		MemLimit: pod.MemLimit, CPULimit: pod.CPULimit, RestartPolicy: pod.RestartPolicy,
		MaxSkillConcurrency: pod.MaxSkillConcurrency, MaxBrowserConcurrency: pod.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: pod.MaxLongTaskConcurrency,
	}
	applyStringPointer(&next.MemLimit, request.MemLimit)
	applyStringPointer(&next.CPULimit, request.CPULimit)
	applyStringPointer(&next.RestartPolicy, request.RestartPolicy)
	applyIntPointer(&next.MaxSkillConcurrency, request.MaxSkillConcurrency)
	applyIntPointer(&next.MaxBrowserConcurrency, request.MaxBrowserConcurrency)
	applyIntPointer(&next.MaxLongTaskConcurrency, request.MaxLongTaskConcurrency)
	return next
}

func resourceChanges(pod repo.Pod, next repo.PodResourceUpdate) (bool, bool) {
	resourceChanged := pod.MemLimit != next.MemLimit || pod.CPULimit != next.CPULimit ||
		pod.RestartPolicy != next.RestartPolicy
	concurrencyChanged := pod.MaxSkillConcurrency != next.MaxSkillConcurrency ||
		pod.MaxBrowserConcurrency != next.MaxBrowserConcurrency ||
		pod.MaxLongTaskConcurrency != next.MaxLongTaskConcurrency
	return resourceChanged, concurrencyChanged
}

func applyStringPointer(target *string, value *string) {
	if value != nil {
		*target = strings.TrimSpace(*value)
	}
}

func applyIntPointer(target *int, value *int) {
	if value != nil {
		*target = *value
	}
}

func podResourceSpec(pod repo.Pod) driver.ResourceSpec {
	return driver.ResourceSpec{
		MemLimit: pod.MemLimit, CPULimit: pod.CPULimit, RestartPolicy: pod.RestartPolicy,
		MaxSkillConcurrency: pod.MaxSkillConcurrency, MaxBrowserConcurrency: pod.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: pod.MaxLongTaskConcurrency,
	}
}

func toResourceValues(spec driver.ResourceSpec) resourceValues {
	return resourceValues{
		MemLimit: spec.MemLimit, CPULimit: spec.CPULimit, RestartPolicy: spec.RestartPolicy,
		MaxSkillConcurrency:    spec.MaxSkillConcurrency,
		MaxBrowserConcurrency:  spec.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: spec.MaxLongTaskConcurrency,
	}
}

func (s *Server) auditResourceUpdate(r *http.Request, podID string, generation int64) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: auditlog.ActionPodUpdate,
		Target:   podID,
		Metadata: auditlog.Metadata{PodID: podID, Status: "resources", Generation: generation},
	})
	if err != nil {
		log.Printf("resource_update_audit_failed pod=%s error=%v", podID, err)
	}
}
