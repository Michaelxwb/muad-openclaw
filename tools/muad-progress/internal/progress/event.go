package progress

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	TypeProgress = "progress"
	TypeDone     = "done"
	TypeError    = "error"

	DefaultVisibility = "channel"
	DefaultPrivacy    = "public"

	ExitOK                 = 0
	ExitInvalidArgs        = 2
	ExitSensitiveRejected  = 3
	ExitAdapterUnavailable = 4

	MaxTextRunes = 80
)

var errSensitiveText = errors.New("progress text contains sensitive content")

type Event struct {
	Type       string `json:"type"`
	Skill      string `json:"skill,omitempty"`
	Stage      string `json:"stage,omitempty"`
	Text       string `json:"text"`
	ID         string `json:"id,omitempty"`
	Code       string `json:"code,omitempty"`
	Visibility string `json:"visibility"`
	Privacy    string `json:"privacy"`
	Timestamp  string `json:"ts"`
	Delivery   string `json:"delivery,omitempty"`
}

type Result struct {
	OK    bool   `json:"ok"`
	Event *Event `json:"event,omitempty"`
	Error string `json:"error,omitempty"`
}

func newEvent(eventType string, opts commandOptions, now time.Time) Event {
	return Event{
		Type:       eventType,
		Skill:      firstNonEmpty(opts.skill, inferSkillName()),
		Stage:      strings.TrimSpace(opts.stage),
		Text:       strings.TrimSpace(opts.text),
		ID:         strings.TrimSpace(opts.id),
		Code:       strings.TrimSpace(opts.code),
		Visibility: firstNonEmpty(opts.visibility, DefaultVisibility),
		Privacy:    firstNonEmpty(opts.privacy, DefaultPrivacy),
		Timestamp:  now.UTC().Format(time.RFC3339),
	}
}

func validateEvent(event Event) error {
	if event.Type != TypeProgress && event.Type != TypeDone && event.Type != TypeError {
		return fmt.Errorf("unsupported event type %q", event.Type)
	}
	if event.Type == TypeProgress && strings.TrimSpace(event.Stage) == "" {
		return errors.New("--stage is required for stage events")
	}
	if strings.TrimSpace(event.Text) == "" {
		return errors.New("--text is required")
	}
	if utf8.RuneCountInString(event.Text) > MaxTextRunes {
		return fmt.Errorf("--text must be <= %d characters", MaxTextRunes)
	}
	if containsSensitiveText(event.Text) {
		return errSensitiveText
	}
	return nil
}

var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(cookie|set-cookie|authorization|bearer|token|secret|password|passwd|pwd)\b\s*[:=]`),
	regexp.MustCompile(`(?i)\b(ak|sk|api[_-]?key)\b\s*[:=]`),
	regexp.MustCompile(`(?i)\bselect\s+.+\s+from\b`),
	regexp.MustCompile(`(?i)\b(insert|update|delete)\s+.+\s+(into|set|from)\b`),
	regexp.MustCompile(`(?i)\bat\s+[\w./-]+:\d+`),
	regexp.MustCompile(`https?://(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[0-1])\.|192\.168\.)[^\s]+`),
}

func containsSensitiveText(text string) bool {
	normalized := strings.TrimSpace(text)
	for _, pattern := range sensitivePatterns {
		if pattern.MatchString(normalized) {
			return true
		}
	}
	return false
}

func IsSensitiveText(text string) bool {
	return containsSensitiveText(text)
}

func stateDir() string {
	if dir := strings.TrimSpace(os.Getenv("MUAD_PROGRESS_STATE_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ".muad"
	}
	return filepath.Join(home, ".muad")
}

func inferSkillName() string {
	if value := strings.TrimSpace(os.Getenv("MUAD_SKILL_NAME")); value != "" {
		return value
	}
	if value := strings.TrimSpace(os.Getenv("SKILL_NAME")); value != "" {
		return value
	}
	return ""
}

func writeJSONResult(out interface{ Write([]byte) (int, error) }, result Result) {
	encoded, err := json.Marshal(result)
	if err != nil {
		_, _ = out.Write([]byte(`{"ok":false,"error":"json encode failed"}` + "\n"))
		return
	}
	_, _ = out.Write(append(encoded, '\n'))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}
