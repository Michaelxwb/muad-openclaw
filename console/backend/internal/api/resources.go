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
	MaxSkillConcurrency   *int `json:"maxSkillConcurrency"`
	MaxBrowserConcurrency *int `json:"maxBrowserConcurrency"`
}

type resourceValues struct {
	MemLimit              string `json:"memLimit"`
	CPULimit              string `json:"cpuLimit"`
	RestartPolicy         string `json:"restartPolicy"`
	MaxSkillConcurrency   int    `json:"maxSkillConcurrency"`
	MaxBrowserConcurrency int    `json:"maxBrowserConcurrency"`
}

func validateResourceRequest(request resourceFieldsRequest) error {
	if request.MemLimit != nil {
		value := strings.TrimSpace(*request.MemLimit)
		if value != "" && !memPattern.MatchString(value) {
			return errors.New("memLimit must look like 512m / 2g / 2.5g")
		}
		if value != "" {
			if _, err := driver.MemoryLimitMiB(value); err != nil {
				return err
			}
		}
	}
	if request.CPULimit != nil {
		value := strings.TrimSpace(*request.CPULimit)
		parsed, err := strconv.ParseFloat(value, 64)
		if value != "" && (!cpuPattern.MatchString(value) || err != nil || parsed <= 0) {
			return errors.New("cpuLimit must be a positive number like 1.5")
		}
	}
	if request.RestartPolicy != nil {
		value := strings.TrimSpace(*request.RestartPolicy)
		if value != "" && !driver.IsValidRestartPolicy(value) {
			return errors.New("restartPolicy must be no / on-failure / always / unless-stopped")
		}
	}
	return nil
}

func validateConcurrency(request podResourceRequest) error {
	for _, value := range []*int{request.MaxSkillConcurrency, request.MaxBrowserConcurrency} {
		if value != nil && (*value < 0 || *value > maxRuntimeConcurrency) {
			return errors.New("concurrency must be 0 (inherit) or between 1 and 1000")
		}
	}
	return nil
}

func (s *Server) handleGetResources(w http.ResponseWriter, _ *http.Request) {
	global, configured, err := s.readGlobalResources()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "read resource config")
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
		writeErr(w, http.StatusInternalServerError, codeInternal, "read resource config")
		return
	}
	var request resourceFieldsRequest
	if err := decodeJSONBody(w, r, &request); err != nil || validateResourceRequest(request) != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid resource limits")
		return
	}
	next := applyGlobalRequest(current, request)
	if err := s.store.SetResourceGlobal(repo.ResourceConfig{
		MemLimit: next.MemLimit, CPULimit: next.CPULimit, RestartPolicy: next.RestartPolicy,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "save resource config")
		return
	}
	podIDs, err := s.store.MarkPodsInheritingResourcesPending(
		current.MemLimit != next.MemLimit, current.CPULimit != next.CPULimit,
		current.RestartPolicy != next.RestartPolicy,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "mark inheriting Pods pending")
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
		writeRepoError(w, err)
		return
	}
	view, err := s.podResourceView(pod)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "resolve Pod resources")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleSetPodResources(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request podResourceRequest
	if err := decodeJSONBody(w, r, &request); err != nil ||
		validateResourceRequest(request.resourceFieldsRequest) != nil || validateConcurrency(request) != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid resource limits")
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
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditResourceUpdate(r, pod.PodID, generation)
	updated, err := s.store.GetPod(pod.PodID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	view, err := s.podResourceView(updated)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "resolve Pod resources")
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
	}, true, nil
}

func (s *Server) resourceFallback() driver.ResourceSpec {
	if s.cfg == nil {
		return driver.ResourceSpec{}
	}
	return driver.ResourceSpec{
		MemLimit: s.cfg.RuntimeDefaults.MemLimit, CPULimit: s.cfg.RuntimeDefaults.CPULimit,
		RestartPolicy:         s.cfg.RuntimeDefaults.RestartPolicy,
		MaxSkillConcurrency:   s.cfg.RuntimeDefaults.MaxSkillConcurrency,
		MaxBrowserConcurrency: s.cfg.RuntimeDefaults.MaxBrowserConcurrency,
	}
}

func applyGlobalRequest(current driver.ResourceSpec, request resourceFieldsRequest) driver.ResourceSpec {
	next := current
	applyStringPointer(&next.MemLimit, request.MemLimit)
	applyStringPointer(&next.CPULimit, request.CPULimit)
	applyStringPointer(&next.RestartPolicy, request.RestartPolicy)
	return next
}

func applyPodResourceRequest(pod repo.Pod, request podResourceRequest) repo.PodResourceUpdate {
	next := repo.PodResourceUpdate{
		MemLimit: pod.MemLimit, CPULimit: pod.CPULimit, RestartPolicy: pod.RestartPolicy,
		MaxSkillConcurrency: pod.MaxSkillConcurrency, MaxBrowserConcurrency: pod.MaxBrowserConcurrency,
	}
	applyStringPointer(&next.MemLimit, request.MemLimit)
	applyStringPointer(&next.CPULimit, request.CPULimit)
	applyStringPointer(&next.RestartPolicy, request.RestartPolicy)
	applyIntPointer(&next.MaxSkillConcurrency, request.MaxSkillConcurrency)
	applyIntPointer(&next.MaxBrowserConcurrency, request.MaxBrowserConcurrency)
	return next
}

func resourceChanges(pod repo.Pod, next repo.PodResourceUpdate) (bool, bool) {
	resourceChanged := pod.MemLimit != next.MemLimit || pod.CPULimit != next.CPULimit ||
		pod.RestartPolicy != next.RestartPolicy
	concurrencyChanged := pod.MaxSkillConcurrency != next.MaxSkillConcurrency ||
		pod.MaxBrowserConcurrency != next.MaxBrowserConcurrency
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
	}
}

func toResourceValues(spec driver.ResourceSpec) resourceValues {
	return resourceValues{
		MemLimit: spec.MemLimit, CPULimit: spec.CPULimit, RestartPolicy: spec.RestartPolicy,
		MaxSkillConcurrency:   spec.MaxSkillConcurrency,
		MaxBrowserConcurrency: spec.MaxBrowserConcurrency,
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
