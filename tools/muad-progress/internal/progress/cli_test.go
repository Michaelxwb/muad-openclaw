package progress

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunStage_JSONSuccessWithoutAdapter(t *testing.T) {
	t.Setenv("MUAD_PROGRESS_STATE_DIR", t.TempDir())
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Run([]string{"stage", "--stage", "query", "--text", "正在查询 XDR 告警数据", "--skill", "xdr-alert", "--json"}, &stdout, &stderr)

	if code != ExitOK {
		t.Fatalf("expected exit 0, got %d stderr=%s", code, stderr.String())
	}
	var result Result
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if !result.OK || result.Event == nil {
		t.Fatalf("expected ok event, got %#v", result)
	}
	if result.Event.Stage != "query" || result.Event.Skill != "xdr-alert" {
		t.Fatalf("unexpected event: %#v", result.Event)
	}
	if result.Event.Delivery != "adapter_unavailable" {
		t.Fatalf("unexpected delivery: %s", result.Event.Delivery)
	}
}

func TestRunStage_RejectsSensitiveText(t *testing.T) {
	t.Setenv("MUAD_PROGRESS_STATE_DIR", t.TempDir())
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Run([]string{"stage", "--stage", "auth", "--text", "token=secret-value", "--json"}, &stdout, &stderr)

	if code != ExitSensitiveRejected {
		t.Fatalf("expected sensitive exit, got %d", code)
	}
	if !strings.Contains(stderr.String(), "sensitive") {
		t.Fatalf("expected sensitive stderr, got %q", stderr.String())
	}
}

func TestRunStage_ThrottleDuplicate(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MUAD_PROGRESS_STATE_DIR", dir)
	t.Setenv("MUAD_PROGRESS_MIN_INTERVAL_MS", "60000")
	var first bytes.Buffer
	var second bytes.Buffer

	code := Run([]string{"stage", "--stage", "query", "--text", "正在查询 XDR 告警数据", "--skill", "xdr", "--json"}, &first, &bytes.Buffer{})
	if code != ExitOK {
		t.Fatalf("first exit = %d", code)
	}
	code = Run([]string{"stage", "--stage", "query", "--text", "正在查询 XDR 告警数据", "--skill", "xdr", "--json"}, &second, &bytes.Buffer{})
	if code != ExitOK {
		t.Fatalf("second exit = %d", code)
	}
	var result Result
	if err := json.Unmarshal(second.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Event == nil || result.Event.Delivery != "throttled" {
		t.Fatalf("expected throttled event, got %#v", result.Event)
	}
}

func TestRunStage_StrictAdapterFailure(t *testing.T) {
	t.Setenv("MUAD_PROGRESS_STATE_DIR", t.TempDir())
	t.Setenv("MUAD_PROGRESS_STRICT_ADAPTER", "1")
	t.Setenv("MUAD_PROGRESS_ADAPTER_CMD", filepath.Join(t.TempDir(), "missing-adapter"))
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Run([]string{"stage", "--stage", "query", "--text", "正在查询 XDR 告警数据", "--json"}, &stdout, &stderr)

	if code != ExitAdapterUnavailable {
		t.Fatalf("expected adapter unavailable, got %d", code)
	}
}

func TestRunDone_DefaultStage(t *testing.T) {
	t.Setenv("MUAD_PROGRESS_STATE_DIR", t.TempDir())
	var stdout bytes.Buffer

	code := Run([]string{"done", "--text", "处理完成", "--json"}, &stdout, &bytes.Buffer{})

	if code != ExitOK {
		t.Fatalf("expected exit 0, got %d", code)
	}
	var result Result
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Event == nil || result.Event.Stage != "done" {
		t.Fatalf("expected done stage, got %#v", result.Event)
	}
}

func TestDiagnosticLogIsWritten(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MUAD_PROGRESS_STATE_DIR", dir)
	code := Run([]string{"stage", "--stage", "query", "--text", "正在查询 XDR 告警数据"}, &bytes.Buffer{}, &bytes.Buffer{})
	if code != ExitOK {
		t.Fatalf("expected exit 0, got %d", code)
	}
	content, err := os.ReadFile(filepath.Join(dir, "progress-events.jsonl"))
	if err != nil {
		t.Fatalf("read diagnostic log: %v", err)
	}
	if !strings.Contains(string(content), "adapter_unavailable") {
		t.Fatalf("expected diagnostic delivery, got %s", string(content))
	}
}

func TestRunWritesEventFileWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	eventFile := filepath.Join(dir, "events.jsonl")
	t.Setenv("MUAD_PROGRESS_STATE_DIR", dir)
	t.Setenv("MUAD_PROGRESS_EVENTS_FILE", eventFile)
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Run([]string{"stage", "--stage", "query", "--text", "正在查询", "--skill", "demo"}, &stdout, &stderr)

	if code != ExitOK {
		t.Fatalf("expected exit 0, got %d stderr=%s", code, stderr.String())
	}
	content, err := os.ReadFile(eventFile)
	if err != nil {
		t.Fatalf("read event file: %v", err)
	}
	var event Event
	if err := json.Unmarshal(bytes.TrimSpace(content), &event); err != nil {
		t.Fatalf("decode event: %v content=%s", err, string(content))
	}
	if event.Stage != "query" || event.Text != "正在查询" || event.Skill != "demo" {
		t.Fatalf("unexpected event: %#v", event)
	}
	if event.Delivery != "" {
		t.Fatalf("event file should not persist delivery before runner handles it: %#v", event)
	}
	diagnostic, err := os.ReadFile(filepath.Join(dir, "progress-events.jsonl"))
	if err != nil {
		t.Fatalf("read diagnostic log: %v", err)
	}
	if !strings.Contains(string(diagnostic), "queued") {
		t.Fatalf("expected queued diagnostic, got %s", string(diagnostic))
	}
}
