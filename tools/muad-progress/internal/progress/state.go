package progress

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultMinInterval = 10 * time.Second
	defaultMaxEvents   = 100
)

type throttleEntry struct {
	LastText string    `json:"lastText"`
	LastAt   time.Time `json:"lastAt"`
	Count    int       `json:"count"`
}

type throttleState struct {
	Entries map[string]throttleEntry `json:"entries"`
}

func shouldThrottle(event Event, now time.Time) (bool, error) {
	if event.Type != TypeProgress {
		return false, nil
	}
	path := filepath.Join(stateDir(), "progress-state.json")
	var throttled bool
	err := withThrottleStateLock(path, func() error {
		state, err := readThrottleState(path)
		if err != nil {
			return err
		}
		throttled = updateThrottleState(state, event, now)
		return writeThrottleState(path, state)
	})
	return throttled, err
}

func updateThrottleState(state throttleState, event Event, now time.Time) bool {
	key := throttleKey(event)
	entry := state.Entries[key]
	minInterval := readDurationEnv("MUAD_PROGRESS_MIN_INTERVAL_MS", defaultMinInterval)
	maxEvents := readIntEnv("MUAD_PROGRESS_MAX_EVENTS", defaultMaxEvents)
	if now.Sub(entry.LastAt) >= minInterval {
		entry.Count = 0
	}
	if entry.Count >= maxEvents && maxEvents > 0 {
		return true
	}
	if entry.LastText == event.Text && now.Sub(entry.LastAt) < minInterval {
		return true
	}
	state.Entries[key] = throttleEntry{
		LastText: event.Text,
		LastAt:   now.UTC(),
		Count:    entry.Count + 1,
	}
	return false
}

func withThrottleStateLock(path string, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open throttle lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock throttle state: %w", err)
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()
	return fn()
}

func readThrottleState(path string) (throttleState, error) {
	state := throttleState{Entries: map[string]throttleEntry{}}
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return state, nil
		}
		return state, fmt.Errorf("read throttle state: %w", err)
	}
	if len(content) == 0 {
		return state, nil
	}
	if err := json.Unmarshal(content, &state); err != nil {
		return state, fmt.Errorf("parse throttle state: %w", err)
	}
	if state.Entries == nil {
		state.Entries = map[string]throttleEntry{}
	}
	return state, nil
}

func writeThrottleState(path string, state throttleState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	content, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode throttle state: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".progress-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create throttle state temp: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write throttle state temp: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close throttle state temp: %w", err)
	}
	if err := os.Chmod(tempName, 0o600); err != nil {
		return fmt.Errorf("chmod throttle state temp: %w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("write throttle state: %w", err)
	}
	return nil
}

func throttleKey(event Event) string {
	parts := []string{event.Skill, event.ID, event.Stage}
	return strings.Join(parts, "|")
}

func readDurationEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	millis, err := strconv.Atoi(value)
	if err != nil || millis < 0 {
		return fallback
	}
	return time.Duration(millis) * time.Millisecond
}

func readIntEnv(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}
