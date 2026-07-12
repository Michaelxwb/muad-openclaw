package api

import (
	"sync"
	"time"
)

type bindingAttemptBucket struct {
	attempts []time.Time
	lastSeen time.Time
}

type bindingAttemptLimiter struct {
	mu          sync.Mutex
	window      time.Duration
	maxAttempts int
	maxKeys     int
	buckets     map[string]bindingAttemptBucket
}

func newBindingAttemptLimiter(
	window time.Duration, maxAttempts, maxKeys int,
) *bindingAttemptLimiter {
	return &bindingAttemptLimiter{
		window: window, maxAttempts: maxAttempts, maxKeys: maxKeys,
		buckets: make(map[string]bindingAttemptBucket),
	}
}

func (limiter *bindingAttemptLimiter) Allow(key string, now time.Time) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.removeExpired(now)
	bucket := limiter.buckets[key]
	bucket.attempts = recentAttempts(bucket.attempts, now.Add(-limiter.window))
	if len(bucket.attempts) >= limiter.maxAttempts {
		retry := bucket.attempts[0].Add(limiter.window).Sub(now)
		return false, max(time.Second, retry)
	}
	if _, exists := limiter.buckets[key]; !exists && len(limiter.buckets) >= limiter.maxKeys {
		limiter.evictOldest()
	}
	bucket.attempts = append(bucket.attempts, now)
	bucket.lastSeen = now
	limiter.buckets[key] = bucket
	return true, 0
}

func (limiter *bindingAttemptLimiter) Reset(key string) {
	limiter.mu.Lock()
	delete(limiter.buckets, key)
	limiter.mu.Unlock()
}

func (limiter *bindingAttemptLimiter) removeExpired(now time.Time) {
	cutoff := now.Add(-limiter.window)
	for key, bucket := range limiter.buckets {
		if bucket.lastSeen.Before(cutoff) {
			delete(limiter.buckets, key)
		}
	}
}

func (limiter *bindingAttemptLimiter) evictOldest() {
	oldestKey := ""
	var oldest time.Time
	for key, bucket := range limiter.buckets {
		if oldestKey == "" || bucket.lastSeen.Before(oldest) {
			oldestKey, oldest = key, bucket.lastSeen
		}
	}
	delete(limiter.buckets, oldestKey)
}

func recentAttempts(input []time.Time, cutoff time.Time) []time.Time {
	index := 0
	for index < len(input) && input[index].Before(cutoff) {
		index++
	}
	return append([]time.Time(nil), input[index:]...)
}
