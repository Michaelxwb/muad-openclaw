package progress

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	state, err := readThrottleState(path)
	if err != nil {
		return false, err
	}
	key := throttleKey(event)
	entry := state.Entries[key]
	minInterval := readDurationEnv("MUAD_PROGRESS_MIN_INTERVAL_MS", defaultMinInterval)
	maxEvents := readIntEnv("MUAD_PROGRESS_MAX_EVENTS", defaultMaxEvents)
	if entry.Count >= maxEvents && maxEvents > 0 {
		return true, writeThrottleState(path, state)
	}
	if entry.LastText == event.Text && now.Sub(entry.LastAt) < minInterval {
		return true, writeThrottleState(path, state)
	}
	state.Entries[key] = throttleEntry{
		LastText: event.Text,
		LastAt:   now.UTC(),
		Count:    entry.Count + 1,
	}
	return false, writeThrottleState(path, state)
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
		return throttleState{Entries: map[string]throttleEntry{}}, nil
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
	if err := os.WriteFile(path, content, 0o600); err != nil {
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
