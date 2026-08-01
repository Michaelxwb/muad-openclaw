package runtimeconfig

import (
	"reflect"
	"testing"
)

// copyStrings 必须保证返回非 nil 切片：validateRuntimeAgents 要求
// agent.Skills != nil，而 append([]string(nil), 空values...) 会返回 nil，
// 导致无任何 effective skill 的用户 apply 失败。
func TestCopyStringsNeverNil(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input []string
	}{
		{name: "nil", input: nil},
		{name: "empty", input: []string{}},
		{name: "values", input: []string{"skill-a", "skill-b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := copyStrings(tc.input)
			if got == nil {
				t.Fatalf("copyStrings(%v) returned nil, want non-nil", tc.input)
			}
			if tc.input != nil && !reflect.DeepEqual(got, tc.input) {
				t.Fatalf("copyStrings(%v) = %v, want %v", tc.input, got, tc.input)
			}
		})
	}
}

func TestCopyStringsCopiesNotAliases(t *testing.T) {
	source := []string{"skill-a"}
	got := copyStrings(source)
	source[0] = "mutated"
	if got[0] != "skill-a" {
		t.Fatalf("copyStrings aliased the source slice: got[0] = %q", got[0])
	}
}
