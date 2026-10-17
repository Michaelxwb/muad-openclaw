package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/notify"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const notifyTestMessage = "muad-console 告警通道测试"

type notifySettingsRequest struct {
	Enabled *bool   `json:"enabled"`
	Webhook *string `json:"webhook"`
}

type notifySettingsResponse struct {
	Enabled   bool   `json:"enabled"`
	Webhook   string `json:"webhook"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Server) handleGetNotifySettings(w http.ResponseWriter, r *http.Request) {
	channel, found, err := s.readNotifyChannel(false)
	if err != nil {
		writeErr(w, r, errcode.InternalReadNotifyConfig)
		return
	}
	if !found {
		writeJSON(w, http.StatusOK, notifySettingsResponse{})
		return
	}
	webhook, err := s.decryptNotifyWebhook(channel)
	if err != nil {
		writeErrDetail(w, r, errcode.InternalReadNotifyConfig, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, notifySettingsResponse{
		Enabled: channel.Enabled, Webhook: notify.MaskWebhook(webhook),
		UpdatedAt: channel.UpdatedAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handlePutNotifySettings(w http.ResponseWriter, r *http.Request) {
	var request notifySettingsRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErrDetail(w, r, errcode.InvalidRequestBody, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	existing, found, err := s.readNotifyChannel(false)
	if err != nil {
		writeErr(w, r, errcode.InternalReadNotifyConfig)
		return
	}
	encrypted, createdAt := "", time.Time{}
	channelID, name := "", "wecom-alert"
	if found {
		encrypted, createdAt = existing.ConfigEnc, existing.CreatedAt
		channelID, name = existing.ChannelID, existing.Name
	}
	if request.Webhook != nil {
		if webhook := strings.TrimSpace(*request.Webhook); webhook != "" {
			if err := notify.ValidateWebhook(webhook); err != nil {
				writeErrDetail(w, r, errcode.InvalidNotifyWebhook, err.Error())
				return
			}
			ciphertext, err := s.encryptNotifyWebhook(webhook)
			if err != nil {
				writeErrDetail(w, r, errcode.InternalSaveNotifyConfig, auditlog.RedactDiagnostic(err.Error()))
				return
			}
			encrypted = ciphertext
		}
	}
	enabled := found && existing.Enabled
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	if encrypted == "" {
		writeErrDetail(w, r, errcode.InvalidNotifyWebhook,
			localizedDetail(r, "启用告警前必须配置 Webhook", "A webhook is required before enabling alerts"))
		return
	}
	saved, err := s.store.UpsertNotifyChannel(repo.NotifyChannel{
		ChannelID: channelID, Type: repo.NotifyChannelTypeWecom, Name: name,
		ConfigEnc: encrypted, Enabled: enabled, CreatedAt: createdAt,
	})
	if err != nil {
		writeErrDetail(w, r, errcode.InternalSaveNotifyConfig, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	s.auditNotifySettings(r, saved)
	webhook, err := s.decryptNotifyWebhook(saved)
	if err != nil {
		writeErrDetail(w, r, errcode.InternalReadNotifyConfig, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, notifySettingsResponse{
		Enabled: saved.Enabled, Webhook: notify.MaskWebhook(webhook),
		UpdatedAt: saved.UpdatedAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleTestNotify(w http.ResponseWriter, r *http.Request) {
	result, err := s.notifier.SendOnce(r.Context(), notify.Event{
		Type: "settings.notify_test", Message: notifyTestMessage,
	})
	if errors.Is(err, notify.ErrNoChannel) {
		writeErrDetail(w, r, errcode.InvalidNotifyWebhook,
			localizedDetail(r, "告警通道未配置或已关闭", "Alert channel is not configured or is disabled"))
		return
	}
	var configErr *notify.ConfigError
	if errors.As(err, &configErr) {
		writeErrDetail(w, r, errcode.InternalReadNotifyConfig, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	if err != nil {
		writeErrDetail(w, r, errcode.UpstreamNotifyFailed, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": result.Errcode == 0, "errcode": result.Errcode,
		"errmsg": auditlog.RedactDiagnostic(result.ErrMsg),
	})
}

// resolveNotifyChannel loads the enabled channel and decrypts its webhook.
// It runs on the dispatcher worker, never inside a request handler path.
func (s *Server) resolveNotifyChannel(_ context.Context) (notify.Channel, error) {
	channel, found, err := s.readNotifyChannel(true)
	if err != nil {
		return nil, &notify.ConfigError{Err: err}
	}
	if !found {
		return nil, notify.ErrNoChannel
	}
	webhook, err := s.decryptNotifyWebhook(channel)
	if err != nil {
		return nil, &notify.ConfigError{Err: err}
	}
	built, err := s.notifyChannelFactory(webhook)
	if err != nil {
		return nil, &notify.ConfigError{Err: err}
	}
	return built, nil
}

func (s *Server) readNotifyChannel(enabledOnly bool) (repo.NotifyChannel, bool, error) {
	channels, err := s.store.ListNotifyChannels()
	if err != nil {
		return repo.NotifyChannel{}, false, err
	}
	for _, channel := range channels {
		if channel.Type != repo.NotifyChannelTypeWecom {
			continue
		}
		if enabledOnly && !channel.Enabled {
			continue
		}
		return channel, true, nil
	}
	return repo.NotifyChannel{}, false, nil
}

func (s *Server) encryptNotifyWebhook(webhook string) (string, error) {
	if s.cipher == nil {
		return "", errors.New("notify: cipher unavailable")
	}
	payload, err := json.Marshal(map[string]string{"webhook": webhook})
	if err != nil {
		return "", fmt.Errorf("encode notify config: %w", err)
	}
	ciphertext, err := s.cipher.Encrypt(string(payload))
	if err != nil {
		return "", fmt.Errorf("encrypt notify config: %w", err)
	}
	return ciphertext, nil
}

func (s *Server) decryptNotifyWebhook(channel repo.NotifyChannel) (string, error) {
	if s.cipher == nil {
		return "", errors.New("notify: cipher unavailable")
	}
	plaintext, err := s.cipher.Decrypt(channel.ConfigEnc)
	if err != nil {
		return "", fmt.Errorf("decrypt notify config: %w", err)
	}
	var config struct {
		Webhook string `json:"webhook"`
	}
	if err := json.Unmarshal([]byte(plaintext), &config); err != nil {
		return "", fmt.Errorf("parse notify config: %w", err)
	}
	if strings.TrimSpace(config.Webhook) == "" {
		return "", errors.New("notify: stored webhook is empty")
	}
	return config.Webhook, nil
}

func (s *Server) auditNotifySettings(r *http.Request, channel repo.NotifyChannel) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: auditlog.ActionSettingsUpdate,
		Target:   "notify",
		Metadata: auditlog.Metadata{Status: channel.Type, Count: 1},
	})
	if err != nil {
		log.Printf("settings_update_audit_failed target=notify error=%s",
			auditlog.RedactDiagnostic(err.Error()))
	}
}

func localizedDetail(r *http.Request, zh, en string) string {
	if langFrom(r.Context()) == langEN {
		return en
	}
	return zh
}
