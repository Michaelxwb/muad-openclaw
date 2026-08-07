package api

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

func newErrorRequest() *http.Request {
	return httptest.NewRequest(http.MethodGet, "/", nil)
}

// writeRuntimeFailure 把脱敏后的具体错误放进 detail，message 只保留目录里的
// 本地化友好文案（默认 zh）。
func TestWriteRuntimeFailureIncludesConcreteErrorInDetail(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, newErrorRequest(), errors.New("bundle must contain SKILL.md"), errcode.RuntimeCreatePod)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadGateway)
	}
	body := rec.Body.String()
	if !strings.Contains(body, fmt.Sprintf(`"code":%d`, errcode.RuntimeCreatePod)) {
		t.Fatalf("response %q missing code %d", body, errcode.RuntimeCreatePod)
	}
	if !strings.Contains(body, "创建 Pod 运行时失败") {
		t.Fatalf("response %q missing localized message", body)
	}
	if !strings.Contains(body, "bundle must contain SKILL.md") {
		t.Fatalf("response %q missing concrete detail", body)
	}
	if strings.Contains(body, "bundle must contain SKILL.md") && !strings.Contains(body, `"detail"`) {
		t.Fatalf("response %q puts concrete error outside detail", body)
	}
}

// writeRuntimeFailure 脱敏 sk- 密钥与 token= 赋值，避免泄露到页面（含 detail）。
func TestWriteRuntimeFailureRedactsSecrets(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, newErrorRequest(), errors.New("probe failed: sk-abc123 token=secret-value"), errcode.RuntimeWechatLogin)

	body := rec.Body.String()
	for _, leaked := range []string{"sk-abc123", "secret-value"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("response leaked %q: %s", leaked, body)
		}
	}
}

// err 为 nil 时只返回稳定 message，不输出 detail 字段。
func TestWriteRuntimeFailureNilErrorOmitsDetail(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, newErrorRequest(), nil, errcode.RuntimeCreatePod)

	body := rec.Body.String()
	if !strings.Contains(body, "创建 Pod 运行时失败") {
		t.Fatalf("response missing localized message: %s", body)
	}
	if strings.Contains(body, `"detail"`) {
		t.Fatalf("nil error should not include detail: %s", body)
	}
}
