package api

import (
	"net/http"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type applyRequest struct {
	PodIDs []string `json:"podIds"`
}

// handleApplyLLM retries model reconciliation for selected Pods.
func (s *Server) handleApplyLLM(w http.ResponseWriter, r *http.Request) {
	if s.reconcile == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime reconciler unavailable")
		return
	}
	var request applyRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	podIDs, ok := validPodIDs(request.PodIDs)
	if !ok {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "podIds must contain valid unique Pod IDs")
		return
	}
	pods, _, err := s.store.ListPods(repo.PodListFilter{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Pods")
		return
	}
	known := make(map[string]repo.Pod, len(pods))
	for _, pod := range pods {
		known[pod.PodID] = pod.Pod
	}
	results := make(map[string]string, len(podIDs))
	for _, podID := range podIDs {
		pod, exists := known[podID]
		if !exists {
			results[podID] = "not_found"
		} else if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy {
			results[podID] = "skipped_not_running"
		} else {
			s.enqueueReconcile(podID)
			results[podID] = "queued"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
