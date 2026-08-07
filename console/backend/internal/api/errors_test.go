package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

// errorCatalog 完整性：每个 code 必须有 zh/en 双语文案、合法 HTTP 状态码，
// 且两个语言文案不应相同。
func TestErrorCatalogCompleteness(t *testing.T) {
	if len(errorCatalog) < 100 {
		t.Fatalf("error catalog too small: %d entries", len(errorCatalog))
	}
	for code, def := range errorCatalog {
		if def.zh == "" {
			t.Errorf("code %d missing zh", code)
		}
		if def.en == "" {
			t.Errorf("code %d missing en", code)
		}
		if def.zh == def.en {
			t.Errorf("code %d zh equals en: %q", code, def.zh)
		}
		if code == 0 {
			t.Errorf("code %d is zero", code)
		}
		if def.httpStatus < 100 || def.httpStatus > 599 {
			t.Errorf("code %d has invalid httpStatus %d", code, def.httpStatus)
		}
	}
}

func TestParseLang(t *testing.T) {
	tests := []struct {
		header string
		want   langCode
	}{
		{"zh-CN,zh;q=0.9,en;q=0.8", langZH},
		{"zh", langZH},
		{"ZH", langZH},
		{"en-US,en;q=0.9", langEN},
		{"en", langEN},
		{"fr-FR,fr;q=0.9", langEN},
		{"", langZH},
		{"   ", langZH},
	}
	for _, tt := range tests {
		if got := parseLang(tt.header); got != tt.want {
			t.Errorf("parseLang(%q) = %s, want %s", tt.header, got, tt.want)
		}
	}
}

func TestLangFromDefaultsToZH(t *testing.T) {
	if got := langFrom(context.Background()); got != langZH {
		t.Fatalf("langFrom(empty ctx) = %s, want zh", got)
	}
}

// writeErr 按请求语言返回对应文案；无语言中间件时默认 zh。
func TestWriteErrLocalizesMessageByLanguage(t *testing.T) {
	tests := []struct {
		name    string
		header  string
		wantMsg string
	}{
		{"zh default", "", "请求参数不合法"},
		{"zh explicit", "zh-CN", "请求参数不合法"},
		{"en", "en-US", "Invalid request body"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := newErrorRequest()
			req.Header.Set("Accept-Language", tt.header)
			ctx := context.WithValue(req.Context(), langKey, parseLang(tt.header))
			rec := httptest.NewRecorder()
			writeErr(rec, req.WithContext(ctx), errcode.InvalidRequestBody)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			var body struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("invalid JSON: %v", err)
			}
			if body.Code != errcode.InvalidRequestBody {
				t.Fatalf("code = %d, want %d", body.Code, errcode.InvalidRequestBody)
			}
			if body.Message != tt.wantMsg {
				t.Fatalf("message = %q, want %q", body.Message, tt.wantMsg)
			}
		})
	}
}

// writeErr 不支持 detail 字段；未知 code 回退到 internal.error 且打日志不 panic。
func TestWriteErrUnknownCodeFallsBackToInternalError(t *testing.T) {
	rec := httptest.NewRecorder()
	writeErr(rec, newErrorRequest(), 99999)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if !strings.Contains(rec.Body.String(), `"code":50001`) {
		t.Fatalf("fallback body %q missing code 50001", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"detail"`) {
		t.Fatalf("writeErr must not include detail: %s", rec.Body.String())
	}
}

// errorCatalog 必须覆盖 errcode.AllCodes 的每一个 code，反之亦然——防止新增
// code 漏配 catalog 而在运行时静默回退 internal.error。
func TestErrorCatalogCoversAllCodes(t *testing.T) {
	if len(errorCatalog) != len(errcode.AllCodes) {
		t.Fatalf("error catalog has %d entries, errcode.AllCodes has %d",
			len(errorCatalog), len(errcode.AllCodes))
	}
	for _, code := range errcode.AllCodes {
		if _, ok := errorCatalog[code]; !ok {
			t.Errorf("catalog missing code %d", code)
		}
	}
	for code := range errorCatalog {
		inList := false
		for _, c := range errcode.AllCodes {
			if c == code {
				inList = true
				break
			}
		}
		if !inList {
			t.Errorf("catalog has code %d not declared in errcode.AllCodes", code)
		}
	}
}

// writeRuntimeFailure 在 en 语言下返回英文 message + 脱敏 detail。
func TestWriteRuntimeFailureEnglish(t *testing.T) {
	req := newErrorRequest()
	ctx := context.WithValue(req.Context(), langKey, langEN)
	rec := httptest.NewRecorder()
	writeRuntimeFailure(rec, req.WithContext(ctx), errorWithSecret(), errcode.RuntimeCreatePod)

	body := rec.Body.String()
	if !strings.Contains(body, "Failed to create Pod runtime") {
		t.Fatalf("body %q missing English message", body)
	}
	if strings.Contains(body, "topsecret") {
		t.Fatalf("body leaked secret: %s", body)
	}
}

type secretError struct{}

func (secretError) Error() string { return "dial failed with token=topsecret" }

func errorWithSecret() error { return secretError{} }
