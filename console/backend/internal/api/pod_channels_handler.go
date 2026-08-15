package api

import (
	"log"
	"net/http"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

func (s *Server) handlePutPodChannels(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	var request podChannelsRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	currentChannels, current, err := s.decodeChannelSettings(pod)
	if err != nil {
		writeErr(w, r, errcode.InternalDecodeChannelConfig)
		return
	}
	channels, configs, err := s.normalizeChannelSettings(request, current)
	if err != nil {
		writeInputValidationError(w, r, errcode.InvalidChannelConfig, err)
		return
	}
	// 同值去重：规范化后与当前一致时不改写 DB、不触发 apply/热加载，pod 列表的
	// 配置状态（generation / last_apply_status）保持不动（与 PUT resources 一致）。
	if sameChannelSettings(channels, configs, currentChannels, current) {
		writeJSON(w, http.StatusOK, map[string]any{
			"podId": pod.PodID, "channels": channels,
			"channelConfigs": channelConfigViews(channels, configs),
		})
		return
	}
	channelsJSON, configsEnc, err := s.encodeChannelSettings(channels, configs)
	if err != nil {
		writeErr(w, r, errcode.InternalEncodeChannelConfig)
		return
	}
	update := podUpdateFrom(pod)
	update.Channels, update.ChannelConfigsEnc = channelsJSON, configsEnc
	if err := s.store.UpdatePod(pod.PodID, update); err != nil {
		writeRepoError(w, r, err)
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
