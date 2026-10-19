package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
)

// wecomHost is the only host a WeCom group robot webhook may target.
const wecomHost = "qyapi.weixin.qq.com"

const (
	wecomTimeout         = 5 * time.Second
	wecomMaxResponseBody = 64 << 10
	wecomMaxRedirects    = 3
)

// WeComChannel delivers alerts through one WeCom group robot webhook.
type WeComChannel struct {
	webhook string
	masked  string
	client  *http.Client
}

// WeComOption adjusts the WeCom channel (HTTP client/timeout for tests).
type WeComOption func(*WeComChannel)

// WithHTTPClient keeps the injected transport while preserving the webhook
// host allow-list and redirect policy.
func WithHTTPClient(client *http.Client) WeComOption {
	return func(channel *WeComChannel) {
		if client == nil {
			return
		}
		if client.Transport != nil {
			channel.client.Transport = client.Transport
		}
		if client.Timeout > 0 {
			channel.client.Timeout = client.Timeout
		}
	}
}

// WithTimeout overrides the default 5s delivery timeout.
func WithTimeout(timeout time.Duration) WeComOption {
	return func(channel *WeComChannel) {
		if timeout > 0 {
			channel.client.Timeout = timeout
		}
	}
}

// NewWeComChannel validates the webhook and builds a channel.
func NewWeComChannel(webhook string, opts ...WeComOption) (*WeComChannel, error) {
	webhook = strings.TrimSpace(webhook)
	if err := ValidateWebhook(webhook); err != nil {
		return nil, err
	}
	channel := &WeComChannel{
		webhook: webhook,
		masked:  MaskWebhook(webhook),
		client:  newWeComHTTPClient(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(channel)
		}
	}
	return channel, nil
}

// Name identifies the channel type.
func (channel *WeComChannel) Name() string { return "wecom" }

// ValidateWebhook enforces the https + qyapi.weixin.qq.com allow-list.
func ValidateWebhook(webhook string) error {
	parsed, err := url.Parse(strings.TrimSpace(webhook))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" ||
		!strings.EqualFold(parsed.Host, wecomHost) || parsed.User != nil {
		return errors.New("notify: webhook must be https://qyapi.weixin.qq.com/...")
	}
	return nil
}

// MaskWebhook hides the webhook key for responses and logs.
func MaskWebhook(webhook string) string {
	parsed, err := url.Parse(strings.TrimSpace(webhook))
	if err != nil || parsed.Host == "" {
		return ""
	}
	query := parsed.Query()
	if query.Get("key") != "" {
		query.Set("key", "****")
		parsed.RawQuery = query.Encode()
	}
	return parsed.String()
}

// Send posts one Markdown message. HTTP 200 with errcode != 0 is a permanent
// business failure; transport errors are retryable.
func (channel *WeComChannel) Send(ctx context.Context, event Event) error {
	payload, err := json.Marshal(map[string]any{
		"msgtype":  "markdown",
		"markdown": map[string]string{"content": event.Markdown()},
	})
	if err != nil {
		return fmt.Errorf("wecom: encode payload: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, channel.webhook,
		bytes.NewReader(payload))
	if err != nil {
		return channel.sanitizeError("wecom: build request", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := channel.client.Do(request)
	if err != nil {
		return channel.sanitizeError("wecom: send", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, wecomMaxResponseBody))
	if err != nil {
		return channel.sanitizeError("wecom: read response", err)
	}
	if response.StatusCode != http.StatusOK {
		return channel.sanitizeError(fmt.Sprintf("wecom: unexpected status %d", response.StatusCode), nil)
	}
	var result struct {
		Errcode int    `json:"errcode"`
		Errmsg  string `json:"errmsg"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return channel.sanitizeError("wecom: decode response", err)
	}
	if result.Errcode != 0 {
		return &PermanentError{
			Errcode: result.Errcode,
			Message: auditlog.RedactDiagnostic(result.Errmsg),
		}
	}
	return nil
}

// sanitizeError strips the webhook (and its key) from transport errors.
func (channel *WeComChannel) sanitizeError(label string, err error) error {
	message := label
	if err != nil {
		message += ": " + err.Error()
	}
	if channel.webhook != "" && channel.masked != "" {
		message = strings.ReplaceAll(message, channel.webhook, channel.masked)
	}
	return errors.New(auditlog.RedactDiagnostic(message))
}

func newWeComHTTPClient() *http.Client {
	return &http.Client{
		Timeout:       wecomTimeout,
		CheckRedirect: checkWeComRedirect,
	}
}

func checkWeComRedirect(request *http.Request, via []*http.Request) error {
	if request.URL.Scheme != "https" || !strings.EqualFold(request.URL.Host, wecomHost) {
		return fmt.Errorf("wecom: cross-host redirect to %q rejected", request.URL.Host)
	}
	if len(via) >= wecomMaxRedirects {
		return errors.New("wecom: too many redirects")
	}
	return nil
}
