// Package runtimeupgrade coordinates one-way Pod runtime upgrades: a persisted
// phase journal, fail-forward failure handling, and the maintenance gate that
// freezes writes while an upgrade is in flight. It deliberately has no rollback
// path: state migrations across OpenClaw versions are irreversible, so a failed
// upgrade stops in error for operator repair.
package runtimeupgrade

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Phase is a constrained upgrade stage. Unknown values are treated as
// unfinished so a corrupted journal can never look completed.
type Phase string

const (
	PhasePrepared  Phase = "prepared"
	PhaseStarting  Phase = "starting_target"
	PhaseVerifying Phase = "verifying_technical"
	PhaseCompleted Phase = "completed"
	PhaseFailed    Phase = "failed"
)

// Terminal reports whether the operation reached a final phase.
func (phase Phase) Terminal() bool {
	return phase == PhaseCompleted || phase == PhaseFailed
}

// Operation is the persisted journal record for one Pod upgrade.
type Operation struct {
	OperationID string    `json:"operationId"`
	PodID       string    `json:"podId"`
	Phase       Phase     `json:"phase"`
	SourceImage string    `json:"sourceImage"`
	TargetImage string    `json:"targetImage"`
	Maintenance bool      `json:"maintenance"`
	StartedAt   time.Time `json:"startedAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	Error       string    `json:"error,omitempty"`
}

var podIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Journal persists upgrade operations under a protected directory. Records are
// written atomically (temporary file + rename) with 0600 permissions.
type Journal struct {
	dir string
	mu  sync.Mutex
}

// NewJournal prepares the journal directory (0700).
func NewJournal(dir string) (*Journal, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("runtimeupgrade: journal directory is required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("runtimeupgrade: create journal directory: %w", err)
	}
	return &Journal{dir: dir}, nil
}

// Save writes one operation record atomically.
func (journal *Journal) Save(operation Operation) error {
	if !podIDPattern.MatchString(operation.PodID) {
		return fmt.Errorf("runtimeupgrade: invalid pod id %q", operation.PodID)
	}
	if strings.TrimSpace(operation.OperationID) == "" || strings.ContainsAny(operation.OperationID, `/\`) {
		return fmt.Errorf("runtimeupgrade: invalid operation id %q", operation.OperationID)
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	podDir := filepath.Join(journal.dir, operation.PodID)
	if err := os.MkdirAll(podDir, 0o700); err != nil {
		return fmt.Errorf("runtimeupgrade: create pod journal directory: %w", err)
	}
	raw, err := json.MarshalIndent(operation, "", "  ")
	if err != nil {
		return fmt.Errorf("runtimeupgrade: encode operation: %w", err)
	}
	target := filepath.Join(podDir, operation.OperationID+".json")
	temporary := target + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("runtimeupgrade: write operation: %w", err)
	}
	if err := os.Rename(temporary, target); err != nil {
		return fmt.Errorf("runtimeupgrade: publish operation: %w", err)
	}
	return nil
}

// Load reads one operation record.
func (journal *Journal) Load(podID, operationID string) (Operation, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	raw, err := os.ReadFile(filepath.Join(journal.dir, podID, operationID+".json"))
	if err != nil {
		return Operation{}, err
	}
	var operation Operation
	if err := json.Unmarshal(raw, &operation); err != nil {
		return Operation{}, fmt.Errorf("runtimeupgrade: decode operation: %w", err)
	}
	return operation, nil
}

// Unfinished lists operations that never reached a terminal phase, oldest
// first. Corrupt records are reported instead of silently ignored.
func (journal *Journal) Unfinished() ([]Operation, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	podDirs, err := os.ReadDir(journal.dir)
	if err != nil {
		return nil, fmt.Errorf("runtimeupgrade: read journal directory: %w", err)
	}
	var unfinished []Operation
	for _, podDir := range podDirs {
		if !podDir.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(journal.dir, podDir.Name()))
		if err != nil {
			return nil, fmt.Errorf("runtimeupgrade: read pod journal: %w", err)
		}
		for _, file := range files {
			if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(journal.dir, podDir.Name(), file.Name()))
			if err != nil {
				return nil, fmt.Errorf("runtimeupgrade: read operation: %w", err)
			}
			var operation Operation
			if err := json.Unmarshal(raw, &operation); err != nil {
				return nil, fmt.Errorf("runtimeupgrade: decode operation %s: %w", file.Name(), err)
			}
			if !operation.Phase.Terminal() {
				unfinished = append(unfinished, operation)
			}
		}
	}
	sort.Slice(unfinished, func(i, j int) bool {
		return unfinished[i].StartedAt.Before(unfinished[j].StartedAt)
	})
	return unfinished, nil
}
