package api

import (
	"net/http"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

// Trace error codes must stay in the catalog with stable HTTP statuses so the
// frontend can match on them.
func TestSkillTraceErrorCodesInCatalog(t *testing.T) {
	want := map[int]int{
		errcode.InvalidSkillTrace:       http.StatusBadRequest,
		errcode.ConflictSkillTraceOwner: http.StatusConflict,
	}
	for code, status := range want {
		def, ok := errorCatalog[code]
		if !ok {
			t.Fatalf("error catalog missing code %d", code)
		}
		if def.httpStatus != status {
			t.Fatalf("code %d status = %d, want %d", code, def.httpStatus, status)
		}
	}
}

// The health flag rule is min(maxRequests, limit x ratio), falling back to the
// cap when the platform limit is 0 (unlimited).
func TestSkillHealthFlagRequestThreshold(t *testing.T) {
	cases := []struct {
		limit int
		want  int
	}{
		{limit: 0, want: skillHealthFlagMaxRequests},
		{limit: 1, want: 1},
		{limit: 50, want: 10},
		{limit: 100, want: 20},
		{limit: 1000, want: skillHealthFlagMaxRequests},
		{limit: 1000000, want: skillHealthFlagMaxRequests},
	}
	for _, tt := range cases {
		if got := skillHealthFlagRequestThreshold(tt.limit); got != tt.want {
			t.Errorf("skillHealthFlagRequestThreshold(%d) = %d, want %d", tt.limit, got, tt.want)
		}
	}
}
