package driver

import "testing"

// docker stats CPU% 是每核百分比（100% = 占满 1 核）。ParseStats 必须把它换算成
// 绝对毫核（×10），供 collector 按 limit 计算"已使用/总量"百分比。
func TestParseStats_ConvertsPerCorePercentToMillicores(t *testing.T) {
	cases := []struct {
		in   string
		cPUm int64
		mib  int
	}{
		{"7.7%;541.0MiB / 2GiB", 77, 541},
		{"100%;1GiB / 2GiB", 1000, 1024},
		{"0.5%;128MiB / 2GiB", 5, 128},
		{"0%;128MiB / 2GiB", 0, 128},
	}
	for _, c := range cases {
		st, err := ParseStats(c.in)
		if err != nil {
			t.Errorf("ParseStats(%q) err: %v", c.in, err)
			continue
		}
		if st.CPUm != c.cPUm {
			t.Errorf("ParseStats(%q) CPUm = %d, want %d", c.in, st.CPUm, c.cPUm)
		}
		if st.MemMiB != c.mib {
			t.Errorf("ParseStats(%q) MemMiB = %d, want %d", c.in, st.MemMiB, c.mib)
		}
	}
}
