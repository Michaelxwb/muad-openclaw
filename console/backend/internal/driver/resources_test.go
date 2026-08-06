package driver

import "testing"

func TestCPULimitMilli(t *testing.T) {
	cases := []struct {
		in     string
		want   int64
		errMsg string
	}{
		{"6", 6000, ""},
		{"2.5", 2500, ""},
		{"1000m", 1000, ""},
		{"0.5", 500, ""},
		{"", 0, "empty"},
		{"abc", 0, "invalid"},
		{"0", 0, "invalid"},
		{"-1", 0, "invalid"},
	}
	for _, c := range cases {
		got, err := CPULimitMilli(c.in)
		if c.errMsg == "" {
			if err != nil {
				t.Errorf("CPULimitMilli(%q) unexpected err: %v", c.in, err)
				continue
			}
			if got != c.want {
				t.Errorf("CPULimitMilli(%q) = %d, want %d", c.in, got, c.want)
			}
			continue
		}
		if err == nil {
			t.Errorf("CPULimitMilli(%q) want error, got %d", c.in, got)
		}
	}
}
