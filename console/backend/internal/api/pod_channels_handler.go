package api

import (
	"log"
	"net/http"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
)

func (s *Server) handlePutPodChannels(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request podChannelsRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	_, current, err := s.decodeChannelSettings(pod)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode channel configuration")
		return
	}
	channels, configs, err := s.normalizeChannelSettings(request, current)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid channel configuration")
		return
	}
	channelsJSON, configsEnc, err := s.encodeChannelSettings(channels, configs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "encode channel configuration")
		return
	}
	update := podUpdateFrom(pod)
	update.Channels, update.ChannelConfigsEnc = channelsJSON, configsEnc
	if err := s.store.UpdatePod(pod.PodID, update); err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.refreshPodSpecSecret(r, pod.PodID)
	s.auditChannelUpdate(r, pod.PodID)
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": pod.PodID, "channels": channels,
		"channelConfigs": channelConfigViews(channels, configs),
	})
}

// refreshPodSpecSecret rebuilds the runtime env Secret so channel changes take
// effect on the next Pod restart, mirroring handleApplyPodConfig. Without it the
// Secret keeps the previous channel set and a restart would drop the new channel
// until the next config apply.
func (s *Server) refreshPodSpecSecret(r *http.Request, podID string) {
	updated, err := s.store.GetPod(podID)
	if err != nil {
		log.Printf("pod_spec_refresh_get_failed pod=%s error=%v", podID, err)
		return
	}
	spec, err := s.buildDesiredPodSpec(updated)
	if err != nil {
		log.Printf("pod_spec_refresh_build_failed pod=%s error=%v", podID, err)
		return
	}
	if err := s.drv.UpdateSpec(r.Context(), podID, spec); err != nil {
		log.Printf("pod_spec_refresh_update_failed pod=%s error=%v", podID, err)
	}
}

func (s *Server) auditChannelUpdate(r *http.Request, podID string) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: auditlog.ActionPodUpdate,
		Target: podID, Metadata: auditlog.Metadata{PodID: podID, Status: "channels"},
	})
	if err != nil {
		log.Printf("pod_channel_audit_failed pod=%s error=%v", podID, err)
	}
}
