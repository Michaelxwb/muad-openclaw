package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// rewriteTransport forwards requests addressed to qyapi.weixin.qq.com to a
// local httptest server, keeping webhook host validation intact.
type rewriteTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (transport *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = transport.target.Scheme
	clone.URL.Host = transport.target.Host
	clone.Host = ""
	return transport.base.RoundTrip(clone)
}

func testClient(serverURL string) *http.Client {
	target, err := url.Parse(serverURL)
	if err != nil {
		panic(err)
	}
	return &http.Client{Transport: &rewriteTransport{target: target, base: http.DefaultTransport}}
}

const testWebhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret-key"

func newTestChannel(t *testing.T, handler http.Handler, opts ...WeComOption) *WeComChannel {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	opts = append([]WeComOption{WithHTTPClient(testClient(server.URL))}, opts...)
	channel, err := NewWeComChannel(testWebhook, opts...)
	if err != nil {
		t.Fatalf("NewWeComChannel: %v", err)
	}
	return channel
}

func TestWeComChannelSendsMarkdownMessageAndSucceeds(t *testing.T) {
	var payload map[string]any
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/cgi-bin/webhook/send" {
			t.Errorf("path = %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))

	if err := channel.Send(context.Background(), Event{
		Type: "skill.request_limit", Message: "skill 请求超限",
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if payload["msgtype"] != "markdown" {
		t.Fatalf("msgtype = %v", payload["msgtype"])
	}
	markdown, _ := payload["markdown"].(map[string]any)
	if markdown["content"] != "skill 请求超限" {
		t.Fatalf("content = %v", markdown["content"])
	}
}

func TestWeComChannelBusinessErrorIsPermanent(t *testing.T) {
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errcode":40058,"errmsg":"invalid webhook"}`))
	}))

	err := channel.Send(context.Background(), Event{Type: "skill.request_limit", Message: "x"})
	var permanent *PermanentError
	if !errors.As(err, &permanent) {
		t.Fatalf("error = %v, want PermanentError", err)
	}
	if permanent.Errcode != 40058 {
		t.Fatalf("errcode = %d, want 40058", permanent.Errcode)
	}
}

func TestWeComChannelTimeout(t *testing.T) {
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`{"errcode":0}`))
	}), WithTimeout(30*time.Millisecond))

	err := channel.Send(context.Background(), Event{Type: "skill.request_limit", Message: "x"})
	if err == nil {
		t.Fatal("Send succeeded, want timeout error")
	}
	var permanent *PermanentError
	if errors.As(err, &permanent) {
		t.Fatalf("timeout classified as business error: %v", err)
	}
	if strings.Contains(err.Error(), "test-secret-key") {
		t.Fatalf("error leaked webhook secret: %v", err)
	}
}

func TestWeComChannelRejectsInvalidWebhook(t *testing.T) {
	for _, webhook := range []string{
		"http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k",
		"https://evil.example.com/cgi-bin/webhook/send?key=k",
		"https://qyapi.weixin.qq.com.evil.example/cgi-bin/webhook/send",
		"https://user:pass@qyapi.weixin.qq.com/cgi-bin/webhook/send",
		"",
	} {
		if _, err := NewWeComChannel(webhook); err == nil {
			t.Fatalf("NewWeComChannel(%q) succeeded, want error", webhook)
		}
	}
}

func TestWeComChannelRejectsCrossHostRedirect(t *testing.T) {
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example.com/steal", http.StatusFound)
	}))
	err := channel.Send(context.Background(), Event{Type: "skill.request_limit", Message: "x"})
	if err == nil {
		t.Fatal("Send followed a cross-host redirect")
	}
	if !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("error = %v, want redirect rejection", err)
	}
}

func TestMaskWebhookHidesKey(t *testing.T) {
	masked := MaskWebhook(testWebhook)
	if strings.Contains(masked, "test-secret-key") {
		t.Fatalf("masked webhook leaks secret: %s", masked)
	}
	if !strings.Contains(masked, "key=%2A%2A%2A%2A") && !strings.Contains(masked, "key=****") {
		t.Fatalf("masked webhook = %s, want masked key", masked)
	}
}

func TestDedupKeyIncludesIdentityFields(t *testing.T) {
	base := Event{
		Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
	}
	otherUser := base
	otherUser.HumanUserID = "user-b"
	if base.DedupKey() == otherUser.DedupKey() {
		t.Fatal("different users share a dedup key")
	}
	otherInterface := base
	otherInterface.Interface = "GET mssw /other"
	if base.DedupKey() == otherInterface.DedupKey() {
		t.Fatal("different interfaces share a dedup key")
	}
	if base.DedupKey() != base.DedupKey() {
		t.Fatal("dedup key is not stable")
	}
}

func TestEventTextUsesFriendlyUserName(t *testing.T) {
	event := Event{
		Type: "skill.request_limit", PodID: "pod-a",
		HumanUserID: "user-a", HumanUserName: "Alice", AgentID: "agent-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
		OccurredAt: time.Date(2026, 10, 17, 13, 46, 38, 0, time.UTC),
	}
	text := event.Text()
	if !strings.Contains(text, "用户: Alice (user-a)") {
		t.Fatalf("alert text lacks friendly user name: %s", text)
	}
	if !strings.Contains(text, "Agent: agent-a") {
		t.Fatalf("alert text lacks agent id: %s", text)
	}
	if strings.Contains(text, "用户: user-a\n") {
		t.Fatalf("alert text still uses the raw user id as the primary label: %s", text)
	}

	markdown := event.Markdown()
	if !strings.Contains(markdown, "### Skill 请求超限告警") ||
		!strings.Contains(markdown, "- **用户**：Alice（user-a）") ||
		!strings.Contains(markdown, "- **Agent**：agent-a") {
		t.Fatalf("markdown alert is not operator-friendly: %s", markdown)
	}
	if !strings.Contains(markdown, "> 场景：skill.request_limit") {
		t.Fatalf("markdown alert lacks the scenario quote: %s", markdown)
	}
	if !strings.Contains(markdown, "- **时间**：2026-10-17 21:46:38 UTC+8") {
		t.Fatalf("markdown alert time is not rendered in UTC+8: %s", markdown)
	}

	fallback := Event{Type: "skill.request_limit", HumanUserID: "user-b"}
	if got := fallback.Text(); !strings.Contains(got, "用户: user-b") {
		t.Fatalf("fallback alert text = %s, want the raw user id", got)
	}
}

type recordingChannel struct {
	sends atomic.Int64
	start chan struct{}
	block chan struct{}
	once  sync.Once
}

func (channel *recordingChannel) Name() string { return "recording" }

func (channel *recordingChannel) Send(context.Context, Event) error {
	channel.sends.Add(1)
	if channel.start != nil {
		channel.once.Do(func() { close(channel.start) })
	}
	if channel.block != nil {
		<-channel.block
	}
	return nil
}

func newTestDispatcher(t *testing.T, channel Channel, opts Options) *Dispatcher {
	t.Helper()
	if opts.QueueSize == 0 {
		opts.QueueSize = 16
	}
	if opts.RetryDelay == 0 {
		opts.RetryDelay = 5 * time.Millisecond
	}
	if opts.Provider == nil {
		opts.Provider = func(context.Context) (Channel, error) { return channel, nil }
	}
	dispatcher := New(opts)
	t.Cleanup(dispatcher.Close)
	return dispatcher
}

func TestDispatcherDeduplicatesWithinWindow(t *testing.T) {
	channel := &recordingChannel{}
	dispatcher := newTestDispatcher(t, channel, Options{DedupWindow: 5 * time.Minute})
	event := Event{
		Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
	}
	dispatcher.Publish(context.Background(), event)
	dispatcher.Publish(context.Background(), event)
	waitFor(t, func() bool { return channel.sends.Load() == 1 })
	time.Sleep(50 * time.Millisecond)
	if got := channel.sends.Load(); got != 1 {
		t.Fatalf("deliveries = %d, want 1 (deduplicated)", got)
	}
}

func TestDispatcherDefaultDedupWindowIsThreeMinutes(t *testing.T) {
	channel := &recordingChannel{}
	now := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	dispatcher := newTestDispatcher(t, channel, Options{Now: func() time.Time { return now }})
	event := Event{
		Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
	}

	dispatcher.Publish(context.Background(), event)
	waitFor(t, func() bool { return channel.sends.Load() == 1 })

	now = now.Add(3*time.Minute - time.Second)
	dispatcher.Publish(context.Background(), event)
	time.Sleep(50 * time.Millisecond)
	if got := channel.sends.Load(); got != 1 {
		t.Fatalf("deliveries = %d, want 1 inside the default 3m window", got)
	}

	now = now.Add(time.Second)
	dispatcher.Publish(context.Background(), event)
	waitFor(t, func() bool { return channel.sends.Load() == 2 })
}

func TestDispatcherRateLimitsTenPerMinute(t *testing.T) {
	channel := &recordingChannel{}
	dispatcher := newTestDispatcher(t, channel, Options{
		QueueSize: 32, RateLimit: 10, RateWindow: time.Minute,
	})
	for i := 0; i < 12; i++ {
		dispatcher.Publish(context.Background(), Event{
			Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
			SkillName: "skill-a", Interface: fmt.Sprintf("GET mssw /api/%d", i),
		})
	}
	waitFor(t, func() bool { return channel.sends.Load() >= 10 })
	time.Sleep(100 * time.Millisecond)
	if got := channel.sends.Load(); got != 10 {
		t.Fatalf("deliveries = %d, want 10 (rate limited)", got)
	}
}

func TestDispatcherRetriesNetworkFailureOnce(t *testing.T) {
	var requests atomic.Int64
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	dispatcher := newTestDispatcher(t, channel, Options{})
	dispatcher.Publish(context.Background(), Event{
		Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
	})
	waitFor(t, func() bool { return requests.Load() == 2 })
	time.Sleep(50 * time.Millisecond)
	if got := requests.Load(); got != 2 {
		t.Fatalf("requests = %d, want 2 (one retry)", got)
	}
}

func TestDispatcherDoesNotRetryBusinessError(t *testing.T) {
	var requests atomic.Int64
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"errcode":40058,"errmsg":"invalid"}`))
	}))
	dispatcher := newTestDispatcher(t, channel, Options{})
	dispatcher.Publish(context.Background(), Event{
		Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
	})
	waitFor(t, func() bool { return requests.Load() == 1 })
	time.Sleep(100 * time.Millisecond)
	if got := requests.Load(); got != 1 {
		t.Fatalf("requests = %d, want 1 (business errors are not retried)", got)
	}
}

func TestDispatcherSkipsWhenChannelDisabled(t *testing.T) {
	var requests atomic.Int64
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"errcode":0}`))
	}))
	dispatcher := newTestDispatcher(t, channel, Options{
		Provider: func(context.Context) (Channel, error) { return nil, ErrNoChannel },
	})
	dispatcher.Publish(context.Background(), Event{
		Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /api",
	})
	time.Sleep(100 * time.Millisecond)
	if got := requests.Load(); got != 0 {
		t.Fatalf("requests = %d, want 0 for a disabled channel", got)
	}
}

func TestDispatcherQueueFullDropsWithoutBlocking(t *testing.T) {
	channel := &recordingChannel{start: make(chan struct{}), block: make(chan struct{})}
	var logs atomic.Int64
	dispatcher := newTestDispatcher(t, channel, Options{
		QueueSize: 1,
		Logf: func(format string, args ...any) {
			if strings.Contains(fmt.Sprintf(format, args...), "reason=queue_full") {
				logs.Add(1)
			}
		},
	})
	first := Event{Type: "skill.request_limit", PodID: "pod-a", HumanUserID: "user-a",
		SkillName: "skill-a", Interface: "GET mssw /1"}
	dispatcher.Publish(context.Background(), first)
	select {
	case <-channel.start:
	case <-time.After(time.Second):
		t.Fatal("worker did not start delivering")
	}
	second := first
	second.Interface = "GET mssw /2"
	third := first
	third.Interface = "GET mssw /3"
	done := make(chan struct{})
	go func() {
		dispatcher.Publish(context.Background(), second)
		dispatcher.Publish(context.Background(), third)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full queue")
	}
	close(channel.block)
	waitFor(t, func() bool { return channel.sends.Load() == 2 })
	if logs.Load() == 0 {
		t.Fatal("queue_full drop was not logged")
	}
}

func TestDispatcherCloseIsIdempotent(t *testing.T) {
	dispatcher := newTestDispatcher(t, &recordingChannel{}, Options{})
	dispatcher.Publish(context.Background(), Event{Type: "skill.request_limit", PodID: "p",
		HumanUserID: "u", SkillName: "s", Interface: "i"})
	dispatcher.Close()
	dispatcher.Close()
	dispatcher.Publish(context.Background(), Event{Type: "skill.request_limit", PodID: "p2",
		HumanUserID: "u", SkillName: "s", Interface: "i"})
}

func TestSendOnceReportsBusinessFailure(t *testing.T) {
	channel := newTestChannel(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errcode":40058,"errmsg":"invalid webhook"}`))
	}))
	dispatcher := newTestDispatcher(t, channel, Options{})
	result, err := dispatcher.SendOnce(context.Background(), Event{Type: "settings.notify_test"})
	if err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if result.Errcode != 40058 {
		t.Fatalf("errcode = %d, want 40058", result.Errcode)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}
