package driver

import "testing"

func TestValidLocale(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "zh", want: true},
		{value: "en", want: true},
		{value: "fr", want: false},
		{value: "ZH", want: false},
		{value: "zh-CN", want: false},
		{value: " ", want: false},
	} {
		if got := validLocale(tc.value); got != tc.want {
			t.Errorf("validLocale(%q) = %v, want %v", tc.value, got, tc.want)
		}
	}
}
