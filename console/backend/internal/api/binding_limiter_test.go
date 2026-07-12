package api

import (
	"testing"
	"time"
)

func TestBindingAttemptLimiter_WindowResetAndBoundedKeys(t *testing.T) {
	limiter := newBindingAttemptLimiter(10*time.Minute, 2, 2)
	now := time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC)
	for attempt := 0; attempt < 2; attempt++ {
		if allowed, _ := limiter.Allow("sender-a", now.Add(time.Duration(attempt)*time.Second)); !allowed {
			t.Fatalf("attempt %d unexpectedly rejected", attempt+1)
		}
	}
	if allowed, retry := limiter.Allow("sender-a", now.Add(2*time.Second)); allowed || retry <= 0 {
		t.Fatalf("limited attempt = %t/%s", allowed, retry)
	}
	if allowed, _ := limiter.Allow("sender-a", now.Add(11*time.Minute)); !allowed {
		t.Fatal("expired sender window did not reset")
	}
	_, _ = limiter.Allow("sender-b", now.Add(11*time.Minute))
	_, _ = limiter.Allow("sender-c", now.Add(11*time.Minute))
	if len(limiter.buckets) != 2 {
		t.Fatalf("bucket count = %d, want bounded at 2", len(limiter.buckets))
	}
}
