// Package notify delivers operator alerts to external channels through a
// bounded asynchronous queue. It owns de-duplication, per-channel rate
// limiting, and delivery retry policy; it never touches the database or HTTP
// handlers directly.
package notify

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
)

// ErrNoChannel reports that no enabled notify channel is configured.
var ErrNoChannel = errors.New("notify: no enabled channel")

// ConfigError marks a failure while resolving the configured channel
// (database or decryption), as opposed to a delivery failure.
type ConfigError struct{ Err error }

func (e *ConfigError) Error() string { return "notify: resolve channel: " + e.Err.Error() }
func (e *ConfigError) Unwrap() error { return e.Err }

// alertTimeZone is China Standard Time (UTC+8); alerts are read by operators
// in the local timezone. China has no DST, so a fixed offset is stable.
var alertTimeZone = time.FixedZone("UTC+8", 8*60*60)

// Event is one operator alert.
type Event struct {
	Type          string
	PodID         string
	HumanUserID   string
	HumanUserName string
	AgentID       string
	SkillName     string
	Interface     string
	Message       string
	OccurredAt    time.Time
}

// DedupKey identifies one alert subject. It follows the design contract
// `skill.request_limit:<podId>:<humanUserId>:<skill>:<interface>`.
func (e Event) DedupKey() string {
	return strings.Join([]string{e.scenario(), e.PodID, e.HumanUserID, e.SkillName, e.Interface}, ":")
}

// Text renders the human-readable alert body. Message wins when set.
func (e Event) Text() string {
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	user := strings.TrimSpace(e.HumanUserName)
	userID := strings.TrimSpace(e.HumanUserID)
	if user == "" {
		user = userID
	} else if userID != "" && user != userID {
		// Keep the stable ID beside the display name for operators; a name
		// alone is ambiguous and an ID alone is not friendly.
		user = fmt.Sprintf("%s (%s)", user, userID)
	}
	lines := []string{fmt.Sprintf("场景: %s", e.scenario())}
	for _, field := range []struct{ label, value string }{
		{"Pod", e.PodID}, {"用户", user}, {"Agent", e.AgentID},
		{"Skill", e.SkillName}, {"接口", e.Interface},
	} {
		if field.value != "" {
			lines = append(lines, fmt.Sprintf("%s: %s", field.label, field.value))
		}
	}
	return strings.Join(lines, "\n")
}

// Markdown renders the alert for channels that support Markdown (WeCom group
// robots). Message wins when set.
func (e Event) Markdown() string {
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	title := "运维告警"
	if e.scenario() == "skill.request_limit" {
		title = "Skill 请求超限告警"
	}
	user := strings.TrimSpace(e.HumanUserName)
	userID := strings.TrimSpace(e.HumanUserID)
	if user == "" {
		user = userID
	} else if userID != "" && user != userID {
		user = fmt.Sprintf("%s（%s）", user, userID)
	}
	lines := []string{
		"### " + title,
		"",
		fmt.Sprintf("> 场景：%s", e.scenario()),
	}
	for _, field := range []struct{ label, value string }{
		{"Pod", e.PodID}, {"用户", user}, {"Agent", e.AgentID},
		{"Skill", e.SkillName}, {"接口", e.Interface},
	} {
		if field.value != "" {
			lines = append(lines, fmt.Sprintf("- **%s**：%s", field.label, field.value))
		}
	}
	if !e.OccurredAt.IsZero() {
		lines = append(lines, fmt.Sprintf("- **时间**：%s",
			e.OccurredAt.In(alertTimeZone).Format("2006-01-02 15:04:05 UTC+8")))
	}
	return strings.Join(lines, "\n")
}

func (e Event) scenario() string {
	if strings.TrimSpace(e.Type) == "" {
		return "notify"
	}
	return e.Type
}

// Channel is one delivery target. Send must return a *PermanentError for
// business-level failures the dispatcher must not retry.
type Channel interface {
	Name() string
	Send(ctx context.Context, event Event) error
}

// PermanentError marks a business-level delivery failure (upstream accepted
// the request but rejected the message).
type PermanentError struct {
	Errcode int
	Message string
}

func (e *PermanentError) Error() string {
	return fmt.Sprintf("notify: business error errcode=%d: %s", e.Errcode, e.Message)
}

// Result is the synchronous outcome of SendOnce.
type Result struct {
	Errcode int
	ErrMsg  string
}

// Provider resolves the currently configured channel. Returning ErrNoChannel
// means delivery is disabled.
type Provider func(ctx context.Context) (Channel, error)

// Options configures a Dispatcher. Zero values pick production defaults.
type Options struct {
	Provider    Provider
	QueueSize   int
	DedupWindow time.Duration
	RateLimit   int
	RateWindow  time.Duration
	RetryDelay  time.Duration
	Logf        func(format string, args ...any)
	Now         func() time.Time
}

// Dispatcher queues alerts and delivers them asynchronously.
type Dispatcher struct {
	provider    Provider
	queue       chan Event
	dedupWindow time.Duration
	limiter     *rateLimiter
	retryDelay  time.Duration
	logf        func(format string, args ...any)
	now         func() time.Time

	dedupMu sync.Mutex
	dedup   map[string]time.Time

	lifecycleMu sync.Mutex
	startOnce   sync.Once
	closeOnce   sync.Once
	closed      atomic.Bool
	done        chan struct{}
	wg          sync.WaitGroup
}

// New builds a dispatcher. Call Close to converge its worker goroutine.
func New(opts Options) *Dispatcher {
	queueSize := opts.QueueSize
	if queueSize <= 0 {
		queueSize = 128
	}
	dedupWindow := opts.DedupWindow
	if dedupWindow <= 0 {
		dedupWindow = 5 * time.Minute
	}
	rateLimit := opts.RateLimit
	if rateLimit <= 0 {
		rateLimit = 10
	}
	rateWindow := opts.RateWindow
	if rateWindow <= 0 {
		rateWindow = time.Minute
	}
	retryDelay := opts.RetryDelay
	if retryDelay <= 0 {
		retryDelay = 500 * time.Millisecond
	}
	logf := opts.Logf
	if logf == nil {
		logf = log.Printf
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	provider := opts.Provider
	if provider == nil {
		provider = func(context.Context) (Channel, error) { return nil, ErrNoChannel }
	}
	return &Dispatcher{
		provider:    provider,
		queue:       make(chan Event, queueSize),
		dedupWindow: dedupWindow,
		limiter:     &rateLimiter{limit: rateLimit, window: rateWindow},
		retryDelay:  retryDelay,
		logf:        logf,
		now:         now,
		dedup:       map[string]time.Time{},
		done:        make(chan struct{}),
	}
}

// Publish enqueues one event without blocking. Duplicate subjects inside the
// de-duplication window and events beyond the queue capacity are dropped and
// logged.
func (d *Dispatcher) Publish(ctx context.Context, event Event) {
	if d == nil || d.closed.Load() {
		return
	}
	d.ensureWorker()
	key := event.DedupKey()
	if !d.acceptDedup(key, d.now()) {
		d.logf("notify_dispatch_dropped scenario=%s dedup_key=%q reason=dedup",
			event.scenario(), key)
		return
	}
	select {
	case d.queue <- event:
	default:
		d.logf("notify_dispatch_dropped scenario=%s dedup_key=%q reason=queue_full",
			event.scenario(), key)
	}
}

// SendOnce resolves the current channel and sends one event synchronously,
// without retrying. It reports business failures through Result and only
// returns an error for configuration or transport problems.
func (d *Dispatcher) SendOnce(ctx context.Context, event Event) (Result, error) {
	if d == nil {
		return Result{}, ErrNoChannel
	}
	channel, err := d.provider(ctx)
	if err != nil {
		return Result{}, err
	}
	if channel == nil {
		return Result{}, ErrNoChannel
	}
	if err := channel.Send(ctx, event); err != nil {
		if permanent, ok := asPermanent(err); ok {
			return Result{Errcode: permanent.Errcode, ErrMsg: permanent.Message}, nil
		}
		return Result{}, err
	}
	return Result{Errcode: 0, ErrMsg: "ok"}, nil
}

// Close stops the worker and waits for it to converge. It is idempotent.
func (d *Dispatcher) Close() {
	if d == nil {
		return
	}
	d.closeOnce.Do(func() {
		d.lifecycleMu.Lock()
		d.closed.Store(true)
		close(d.done)
		d.lifecycleMu.Unlock()
	})
	d.wg.Wait()
}

func (d *Dispatcher) ensureWorker() {
	d.lifecycleMu.Lock()
	defer d.lifecycleMu.Unlock()
	if d.closed.Load() {
		return
	}
	d.startOnce.Do(func() {
		d.wg.Add(1)
		go d.run()
	})
}

func (d *Dispatcher) run() {
	defer d.wg.Done()
	for {
		select {
		case <-d.done:
			return
		case event := <-d.queue:
			d.deliver(event)
		}
	}
}

func (d *Dispatcher) deliver(event Event) {
	scenario, key := event.scenario(), event.DedupKey()
	if !d.limiter.Allow(d.now()) {
		d.logf("notify_dispatch_dropped scenario=%s dedup_key=%q reason=rate_limited",
			scenario, key)
		return
	}
	channel, err := d.provider(context.Background())
	if errors.Is(err, ErrNoChannel) || (err == nil && channel == nil) {
		d.logf("notify_delivery scenario=%s dedup_key=%q outcome=disabled", scenario, key)
		return
	}
	if err != nil {
		d.logf("notify_delivery scenario=%s dedup_key=%q outcome=config_error error=%q",
			scenario, key, auditlog.RedactDiagnostic(err.Error()))
		return
	}
	err = channel.Send(context.Background(), event)
	if permanent, ok := asPermanent(err); ok {
		d.logf("notify_delivery scenario=%s dedup_key=%q outcome=business_error errcode=%d errmsg=%q",
			scenario, key, permanent.Errcode, permanent.Message)
		return
	}
	if err != nil {
		d.logf("notify_delivery scenario=%s dedup_key=%q outcome=retry error=%q",
			scenario, key, auditlog.RedactDiagnostic(err.Error()))
		select {
		case <-d.done:
			return
		case <-time.After(d.retryDelay):
		}
		err = channel.Send(context.Background(), event)
	}
	if err == nil {
		d.logf("notify_delivery scenario=%s dedup_key=%q outcome=ok", scenario, key)
		return
	}
	if permanent, ok := asPermanent(err); ok {
		d.logf("notify_delivery scenario=%s dedup_key=%q outcome=business_error errcode=%d errmsg=%q",
			scenario, key, permanent.Errcode, permanent.Message)
		return
	}
	d.logf("notify_delivery scenario=%s dedup_key=%q outcome=retry_failed error=%q",
		scenario, key, auditlog.RedactDiagnostic(err.Error()))
}

func (d *Dispatcher) acceptDedup(key string, now time.Time) bool {
	d.dedupMu.Lock()
	defer d.dedupMu.Unlock()
	if last, ok := d.dedup[key]; ok && now.Sub(last) < d.dedupWindow {
		return false
	}
	d.dedup[key] = now
	if len(d.dedup) > 1024 {
		for existing, seen := range d.dedup {
			if now.Sub(seen) >= d.dedupWindow {
				delete(d.dedup, existing)
			}
		}
	}
	return true
}

func asPermanent(err error) (*PermanentError, bool) {
	var permanent *PermanentError
	if errors.As(err, &permanent) {
		return permanent, true
	}
	return nil, false
}

// rateLimiter is a sliding-window per-channel send limiter.
type rateLimiter struct {
	limit  int
	window time.Duration

	mu       sync.Mutex
	accepted []time.Time
}

func (limiter *rateLimiter) Allow(now time.Time) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	cutoff := now.Add(-limiter.window)
	kept := limiter.accepted[:0]
	for _, at := range limiter.accepted {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	limiter.accepted = kept
	if len(limiter.accepted) >= limiter.limit {
		return false
	}
	limiter.accepted = append(limiter.accepted, now)
	return true
}
