package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// writeRuntimeFailure 必须透传脱敏后的具体错误，页面才能直接看到失败原因
// （如 "install private Skill failed: bundle must contain SKILL.md"）。
func TestWriteRuntimeFailureIncludesConcreteError(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, errors.New("bundle must contain SKILL.md"), "install private Skill failed")

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadGateway)
	}
	body := rec.Body.String()
	for _, want := range []string{`"code":50201`, "install private Skill failed", "bundle must contain SKILL.md"} {
		if !strings.Contains(body, want) {
			t.Fatalf("response %q missing %q", body, want)
		}
	}
}

// writeRuntimeFailure 脱敏 sk- 密钥与 secret= 赋值，避免泄露到页面。
func TestWriteRuntimeFailureRedactsSecrets(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, errors.New("probe failed: sk-abc123 token=secret-value"), "check model")

	body := rec.Body.String()
	for _, leaked := range []string{"sk-abc123", "secret-value"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("response leaked %q: %s", leaked, body)
		}
	}
}

// err 为 nil 时只返回稳定前缀，不追加无意义的分隔后缀。
func TestWriteRuntimeFailureNilErrorKeepsPrefixOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, nil, "create Pod runtime failed")

	body := rec.Body.String()
	if !strings.Contains(body, "create Pod runtime failed") {
		t.Fatalf("response missing action prefix: %s", body)
	}
	if strings.Contains(body, ": ") {
		t.Fatalf("nil error should not append separator: %s", body)
	}
}
