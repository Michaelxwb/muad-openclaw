package test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/notify"
)

const notifyTestWebhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=notify-super-secret"

// webhookRewriteTransport forwards qyapi.weixin.qq.com requests to a local
// httptest server so the WeCom host allow-list stays in effect.
type webhookRewriteTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (transport *webhookRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = transport.target.Scheme
	clone.URL.Host = transport.target.Host
	clone.Host = ""
	return transport.base.RoundTrip(clone)
}

func useNotifyTestServer(e *testEnv, serverURL string) {
	target, _ := url.Parse(serverURL)
	e.srv.WithNotifyChannelFactory(func(webhook string) (notify.Channel, error) {
		return notify.NewWeComChannel(webhook, notify.WithHTTPClient(&http.Client{
			Transport: &webhookRewriteTransport{target: target, base: http.DefaultTransport},
		}))
	})
}

func putNotifySettings(t *testing.T, e *testEnv, body string) *httptest.ResponseRecorder {
	t.Helper()
	return e.do(http.MethodPut, "/api/v1/settings/notify", body)
}

func TestNotifySettingsEncryptsMasksAndAudits(t *testing.T) {
	e := newTestEnv(t)
	response := putNotifySettings(t, e,
		`{"enabled":true,"webhook":"`+notifyTestWebhook+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PUT notify = %d: %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "notify-super-secret") {
		t.Fatalf("PUT response leaks webhook secret: %s", response.Body.String())
	}

	response = e.do(http.MethodGet, "/api/v1/settings/notify", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET notify = %d: %s", response.Code, response.Body.String())
	}
	var got struct {
		Data struct {
			Enabled   bool   `json:"enabled"`
			Webhook   string `json:"webhook"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET notify: %v", err)
	}
	if !got.Data.Enabled {
		t.Fatal("enabled = false, want true")
	}
	if strings.Contains(got.Data.Webhook, "notify-super-secret") || got.Data.Webhook == "" {
		t.Fatalf("webhook not masked: %q", got.Data.Webhook)
	}
	if got.Data.UpdatedAt == "" {
		t.Fatal("updatedAt is empty")
	}

	channels, err := e.store.ListNotifyChannels()
	if err != nil || len(channels) != 1 {
		t.Fatalf("notify channels = %d, error = %v", len(channels), err)
	}
	if channels[0].ConfigEnc == "" || strings.Contains(channels[0].ConfigEnc, "notify-super-secret") {
		t.Fatalf("config stored unencrypted: %q", channels[0].ConfigEnc)
	}
	plaintext, err := e.cipher.Decrypt(channels[0].ConfigEnc)
	if err != nil || !strings.Contains(plaintext, notifyTestWebhook) {
		t.Fatalf("decrypted config = %q, error = %v", plaintext, err)
	}

	entries, _, err := e.store.QueryAudit("root", time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatalf("query audit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "settings.update" {
			found = true
		}
	}
	if !found {
		t.Fatalf("settings.update audit entry missing: %+v", entries)
	}
}

func TestNotifySettingsRejectsForeignWebhook(t *testing.T) {
	e := newTestEnv(t)
	response := putNotifySettings(t, e,
		`{"enabled":true,"webhook":"https://evil.example.com/cgi-bin/webhook/send?key=x"}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":40012`) {
		t.Fatalf("PUT foreign webhook = %d: %s", response.Code, response.Body.String())
	}
}

func TestNotifyTestDeliversThroughDispatcher(t *testing.T) {
	e := newTestEnv(t)
	var requests atomic.Int64
	var payloads []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		body, _ := io.ReadAll(r.Body)
		payloads = append(payloads, string(body))
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	defer server.Close()
	useNotifyTestServer(e, server.URL)

	if response := putNotifySettings(t, e,
		`{"enabled":true,"webhook":"`+notifyTestWebhook+`"}`); response.Code != http.StatusOK {
		t.Fatalf("PUT notify = %d: %s", response.Code, response.Body.String())
	}
	response := e.do(http.MethodPost, "/api/v1/settings/notify/test", "")
	if response.Code != http.StatusOK {
		t.Fatalf("POST notify test = %d: %s", response.Code, response.Body.String())
	}
	var got struct {
		Data struct {
			OK      bool   `json:"ok"`
			Errcode int    `json:"errcode"`
			Errmsg  string `json:"errmsg"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode test response: %v", err)
	}
	if !got.Data.OK || got.Data.Errcode != 0 {
		t.Fatalf("test result = %+v, want ok", got.Data)
	}
	if requests.Load() != 1 {
		t.Fatalf("webhook requests = %d, want 1", requests.Load())
	}
	if len(payloads) == 0 || !strings.Contains(payloads[0], `"msgtype":"markdown"`) {
		t.Fatalf("payload = %q", payloads)
	}
}

func TestNotifyTestBusinessErrorReturnedInEnvelope(t *testing.T) {
	e := newTestEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errcode":40058,"errmsg":"invalid webhook"}`))
	}))
	defer server.Close()
	useNotifyTestServer(e, server.URL)

	if response := putNotifySettings(t, e,
		`{"enabled":true,"webhook":"`+notifyTestWebhook+`"}`); response.Code != http.StatusOK {
		t.Fatalf("PUT notify = %d: %s", response.Code, response.Body.String())
	}
	response := e.do(http.MethodPost, "/api/v1/settings/notify/test", "")
	if response.Code != http.StatusOK {
		t.Fatalf("POST notify test = %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"ok":false`) ||
		!strings.Contains(response.Body.String(), `"errcode":40058`) {
		t.Fatalf("business failure not reported: %s", response.Body.String())
	}
}

func TestNotifyTestUpstreamFailureIsRedacted(t *testing.T) {
	e := newTestEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	useNotifyTestServer(e, server.URL)

	if response := putNotifySettings(t, e,
		`{"enabled":true,"webhook":"`+notifyTestWebhook+`"}`); response.Code != http.StatusOK {
		t.Fatalf("PUT notify = %d: %s", response.Code, response.Body.String())
	}
	response := e.do(http.MethodPost, "/api/v1/settings/notify/test", "")
	if response.Code != http.StatusBadGateway ||
		!strings.Contains(response.Body.String(), `"code":50216`) {
		t.Fatalf("POST notify test = %d: %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "notify-super-secret") {
		t.Fatalf("upstream error leaks webhook secret: %s", response.Body.String())
	}
}

func TestNotifyDisabledChannelSendsNothing(t *testing.T) {
	e := newTestEnv(t)
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"errcode":0}`))
	}))
	defer server.Close()
	useNotifyTestServer(e, server.URL)

	if response := putNotifySettings(t, e,
		`{"enabled":false,"webhook":"`+notifyTestWebhook+`"}`); response.Code != http.StatusOK {
		t.Fatalf("PUT notify = %d: %s", response.Code, response.Body.String())
	}
	response := e.do(http.MethodPost, "/api/v1/settings/notify/test", "")
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":40012`) {
		t.Fatalf("POST notify test on disabled channel = %d: %s", response.Code, response.Body.String())
	}
	if requests.Load() != 0 {
		t.Fatalf("webhook requests = %d, want 0 for a disabled channel", requests.Load())
	}
}
