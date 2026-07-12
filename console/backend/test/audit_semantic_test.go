package test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type auditSink struct {
	entries []repo.AuditEntry
	err     error
}

func (s *auditSink) AddAudit(entry repo.AuditEntry) error {
	if s.err != nil {
		return s.err
	}
	s.entries = append(s.entries, entry)
	return nil
}

func TestSemanticAudit_RecordTypedRedactedEvent(t *testing.T) {
	ctx := auditlog.WithRequestTracker(context.Background())
	sink := &auditSink{}
	event := auditlog.Event{
		Actor:  auditlog.PodActor("66667"),
		Action: auditlog.ActionPlatformCredentialUpdate,
		Target: "human-user-1",
		Metadata: auditlog.Metadata{
			PodID: "66667", HumanUserID: "human-user-1", AgentID: "alice",
			Platform: "xdr", Fingerprint: "sha256:abc", Status: "updated",
		},
	}
	if err := auditlog.Record(ctx, sink, event); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if !auditlog.HasSemanticEvent(ctx) || len(sink.entries) != 1 {
		t.Fatalf("semantic tracker or sink not updated: %+v", sink.entries)
	}
	entry := sink.entries[0]
	if entry.Actor != "pod:66667" || entry.Action != "platform_credential.update" {
		t.Fatalf("unexpected entry: %+v", entry)
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(entry.Payload), &metadata); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if metadata["platform"] != "xdr" || metadata["fingerprint"] != "sha256:abc" {
		t.Fatalf("unexpected metadata: %+v", metadata)
	}
	for _, forbidden := range []string{"apiKey", "cookie", "secret", "bindingCode"} {
		if strings.Contains(strings.ToLower(entry.Payload), strings.ToLower(forbidden)) {
			t.Fatalf("payload contains forbidden field %q: %s", forbidden, entry.Payload)
		}
	}
}

func TestSemanticAudit_RejectsUnknownActionAndMissingActor(t *testing.T) {
	tests := []auditlog.Event{
		{Actor: "admin", Action: auditlog.Action("unknown")},
		{Actor: "", Action: auditlog.ActionPodCreate},
	}
	for _, event := range tests {
		sink := &auditSink{}
		if err := auditlog.Record(context.Background(), sink, event); err == nil {
			t.Fatalf("expected validation error for %+v", event)
		}
		if len(sink.entries) != 0 {
			t.Fatalf("invalid event was persisted: %+v", sink.entries)
		}
	}
}

func TestSemanticAudit_DoesNotMarkFailedWrite(t *testing.T) {
	ctx := auditlog.WithRequestTracker(context.Background())
	sink := &auditSink{err: errors.New("database unavailable")}
	err := auditlog.Record(ctx, sink, auditlog.Event{
		Actor: "admin", Action: auditlog.ActionPodCreate, Target: "pod-a",
	})
	if err == nil {
		t.Fatal("expected sink error")
	}
	if auditlog.HasSemanticEvent(ctx) {
		t.Fatal("failed semantic write must not suppress fallback audit")
	}
}

func TestSemanticAudit_RedactsRuntimeDiagnostics(t *testing.T) {
	input := `resolver failed apiKey=sk-supersecret token=abcdefghi Bearer abc.def.ghi`
	redacted := auditlog.RedactDiagnostic(input)
	for _, secret := range []string{"sk-supersecret", "abcdefghi", "abc.def.ghi"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("diagnostic leaked %q: %s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "[redacted]") {
		t.Fatalf("diagnostic was not visibly redacted: %s", redacted)
	}
}

func TestSemanticAudit_RedactsLogsWithoutTruncatingThem(t *testing.T) {
	input := strings.Repeat("normal-log-line\n", 100) + "api_key=sk-supersecret\n"
	redacted := auditlog.RedactSensitiveText(input)
	if strings.Contains(redacted, "sk-supersecret") || !strings.Contains(redacted, "api_key=[redacted]") {
		t.Fatalf("log was not redacted: %s", redacted)
	}
	if len(redacted) <= 512 || !strings.HasPrefix(redacted, "normal-log-line") {
		t.Fatalf("log redaction unexpectedly truncated output: len=%d", len(redacted))
	}
}
