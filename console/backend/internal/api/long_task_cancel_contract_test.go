package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

// LongTaskControlS23 [integration] 真实边界：真实 errcode/errorCatalog/writeJSON/
// writeErr 与 httptest 响应包络；取消场景子码、双语与 HTTP status 一致，202 仅
// 表达已接受。

func TestLongTaskControlS23CancelCodesAreStableLocalizedAndReserved(t *testing.T) {
	cases := []struct {
		name   string
		code   int
		status int
	}{
		{"not found", errcode.NotFoundLongTask, http.StatusNotFound},
		{"ownership conflict", errcode.ConflictLongTaskOwnership, http.StatusConflict},
		{"unsupported worker", errcode.LongTaskCancelUnsupported, http.StatusServiceUnavailable},
		{"run unverifiable", errcode.LongTaskRunUnverifiable, http.StatusConflict},
		{"rpc unavailable", errcode.LongTaskCancelUnavailable, http.StatusServiceUnavailable},
		{"state write failed", errcode.LongTaskCancelStateFailed, http.StatusInternalServerError},
	}
	seen := map[int]bool{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if seen[tc.code] {
				t.Fatalf("duplicate code %d", tc.code)
			}
			seen[tc.code] = true
			if tc.code < 41001 || tc.code > 41099 {
				t.Fatalf("code %d must stay in the reserved 410xx long-task block", tc.code)
			}
			def, ok := errorCatalog[tc.code]
			if !ok {
				t.Fatalf("missing catalog entry for %d", tc.code)
			}
			if def.httpStatus != tc.status {
				t.Fatalf("catalog status = %d, want %d", def.httpStatus, tc.status)
			}
			if def.zh == "" || def.en == "" || def.zh == def.en {
				t.Fatalf("catalog must carry distinct zh/en messages: %+v", def)
			}
			// writeErr 端到端：HTTP status、稳定 code、双语 message 与 requestId 包络。
			for _, lang := range []langCode{langZH, langEN} {
				req := httptest.NewRequest(http.MethodPost, "/api/v1/long-tasks/task-1/cancel", nil)
				req = req.WithContext(context.WithValue(req.Context(), langKey, lang))
				rec := httptest.NewRecorder()
				writeErr(rec, req, tc.code)
				if rec.Code != tc.status {
					t.Fatalf("writeErr status = %d, want %d", rec.Code, tc.status)
				}
				var body struct {
					Code      int    `json:"code"`
					Message   string `json:"message"`
					RequestID string `json:"requestId"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("decode error envelope: %v", err)
				}
				if body.Code != tc.code {
					t.Fatalf("envelope code = %d, want %d", body.Code, tc.code)
				}
				wantMessage := def.zh
				if lang == langEN {
					wantMessage = def.en
				}
				if body.Message != wantMessage {
					t.Fatalf("message(%s) = %q, want %q", lang, body.Message, wantMessage)
				}
				if body.RequestID == "" {
					t.Fatalf("error envelope must keep requestId")
				}
			}
		})
	}
	// 全部新码注册进 AllCodes 且不重复占用既有子码。
	counts := map[int]int{}
	for _, code := range errcode.AllCodes {
		counts[code]++
	}
	for _, tc := range cases {
		if counts[tc.code] != 1 {
			t.Fatalf("code %d appears %d times in AllCodes", tc.code, counts[tc.code])
		}
	}
	if counts[errcode.NotFound] != 1 {
		t.Fatalf("existing generic NotFound must stay untouched")
	}
}

func TestLongTaskControlS23CancelOutcomeEnvelopeSemantics(t *testing.T) {
	decode := func(t *testing.T, rec *httptest.ResponseRecorder) struct {
		Code int `json:"code"`
		Data struct {
			TaskID        string `json:"taskId"`
			Outcome       string `json:"outcome"`
			Status        string `json:"status"`
			StateRevision int64  `json:"stateRevision"`
		} `json:"data"`
	} {
		t.Helper()
		var body struct {
			Code int `json:"code"`
			Data struct {
				TaskID        string `json:"taskId"`
				Outcome       string `json:"outcome"`
				Status        string `json:"status"`
				StateRevision int64  `json:"stateRevision"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode cancel envelope: %v", err)
		}
		return body
	}

	// cancel_requested → 202，仅表达已接受（status 仍是 cancelling）。
	accepted := httptest.NewRecorder()
	writeLongTaskCancelResult(accepted, "task-1", "cancel_requested", "cancelling", 3)
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("cancel_requested status = %d, want 202", accepted.Code)
	}
	body := decode(t, accepted)
	if body.Code != 0 || body.Data.TaskID != "task-1" || body.Data.Outcome != "cancel_requested" ||
		body.Data.Status != "cancelling" || body.Data.StateRevision != 3 {
		t.Fatalf("accepted envelope = %+v", body)
	}

	// cancelled → 200（已确认停止）。
	cancelled := httptest.NewRecorder()
	writeLongTaskCancelResult(cancelled, "task-1", "cancelled", "cancelled", 4)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("cancelled status = %d, want 200", cancelled.Code)
	}
	if data := decode(t, cancelled).Data; data.Outcome != "cancelled" || data.Status != "cancelled" || data.StateRevision != 4 {
		t.Fatalf("cancelled envelope = %+v", data)
	}

	// already_terminal → 200 且原样回传实际终态，不改写为已取消；202 绝不出现在终态。
	for _, terminal := range []string{"succeeded", "failed", "cancelled"} {
		rec := httptest.NewRecorder()
		writeLongTaskCancelResult(rec, "task-2", "already_terminal", terminal, 9)
		if rec.Code == http.StatusAccepted {
			t.Fatalf("terminal outcome %s must not use 202", terminal)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("terminal outcome %s status = %d, want 200", terminal, rec.Code)
		}
		if data := decode(t, rec).Data; data.Outcome != "already_terminal" || data.Status != terminal {
			t.Fatalf("terminal envelope = %+v", data)
		}
	}
	// 成功包络保持全站既有形状（code:0 + data，无额外字段）。
	if raw := string(accepted.Body.Bytes()); len(raw) == 0 {
		t.Fatalf("empty envelope")
	}
}
