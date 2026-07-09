package progress

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const adapterTimeout = 2 * time.Second

func deliverEvent(event Event) (string, error) {
	if path := strings.TrimSpace(os.Getenv("MUAD_PROGRESS_EVENTS_FILE")); path != "" {
		if err := appendEventFile(path, event); err != nil {
			_ = appendDiagnostic(event, "event_file_unavailable")
			return "event_file_unavailable", err
		}
		_ = appendDiagnostic(event, "queued")
		return "queued", nil
	}
	command := strings.TrimSpace(os.Getenv("MUAD_PROGRESS_ADAPTER_CMD"))
	if command == "" {
		if err := appendDiagnostic(event, "adapter_unavailable"); err != nil {
			return "adapter_unavailable", err
		}
		if strictAdapter() {
			return "adapter_unavailable", fmt.Errorf("MUAD_PROGRESS_ADAPTER_CMD is not configured")
		}
		return "adapter_unavailable", nil
	}
	args := strings.Fields(command)
	if len(args) == 0 {
		return "adapter_unavailable", fmt.Errorf("adapter command is empty")
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return "adapter_unavailable", fmt.Errorf("encode adapter event: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), adapterTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Stdin = bytes.NewReader(payload)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			err = fmt.Errorf("%w: %s", err, detail)
		}
		_ = appendDiagnostic(event, "adapter_unavailable")
		return "adapter_unavailable", err
	}
	_ = appendDiagnostic(event, "sent")
	return "sent", nil
}

func appendEventFile(path string, event Event) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("MUAD_PROGRESS_EVENTS_FILE must be absolute")
	}
	copyEvent := event
	if containsSensitiveText(copyEvent.Text) {
		copyEvent.Text = "[redacted]"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create progress event dir: %w", err)
	}
	content, err := json.Marshal(copyEvent)
	if err != nil {
		return fmt.Errorf("encode progress event: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open progress event file: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(content, '\n')); err != nil {
		return fmt.Errorf("write progress event file: %w", err)
	}
	return nil
}

func appendDiagnostic(event Event, delivery string) error {
	copyEvent := event
	copyEvent.Delivery = delivery
	if containsSensitiveText(copyEvent.Text) {
		copyEvent.Text = "[redacted]"
	}
	path := filepath.Join(stateDir(), "progress-events.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create diagnostic dir: %w", err)
	}
	content, err := json.Marshal(copyEvent)
	if err != nil {
		return fmt.Errorf("encode diagnostic event: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open diagnostic log: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(content, '\n')); err != nil {
		return fmt.Errorf("write diagnostic log: %w", err)
	}
	return nil
}

func strictAdapter() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("MUAD_PROGRESS_STRICT_ADAPTER")))
	return value == "1" || value == "true" || value == "yes"
}
