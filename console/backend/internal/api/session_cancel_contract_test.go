package api

import (
	"net/http"
	"slices"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

// 会话终止的稳定错误码必须同时存在于 errcode.AllCodes 与 errorCatalog，
// 且 HTTP 状态、zh/en 文案符合设计契约（41007/41008 冲突/未找到，41010 上游失败）。
func TestSessionCancelErrorCodesAreCatalogued(t *testing.T) {
	cases := []struct {
		name   string
		code   int
		status int
	}{
		{"unsupported", errcode.SessionCancelUnsupported, http.StatusConflict},
		{"not_found", errcode.NotFoundSession, http.StatusNotFound},
		{"preview_stale", errcode.ConflictSessionPreviewStale, http.StatusConflict},
		{"failed", errcode.SessionCancelFailed, http.StatusBadGateway},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !slices.Contains(errcode.AllCodes, tc.code) {
				t.Fatalf("code %d missing from errcode.AllCodes", tc.code)
			}
			def, ok := errorCatalog[tc.code]
			if !ok {
				t.Fatalf("code %d missing from errorCatalog", tc.code)
			}
			if def.httpStatus != tc.status {
				t.Fatalf("code %d http status = %d, want %d", tc.code, def.httpStatus, tc.status)
			}
			if def.zh == "" || def.en == "" {
				t.Fatalf("code %d must have zh/en messages", tc.code)
			}
		})
	}
}
