package driver

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestRuntimeFileTask007_E04K8sSecretFailure(t *testing.T) {
	d := newFakeK8s(t)
	spec := fileRuntimeSpec(t, "alice")
	ctx := context.Background()
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	name := ContainerName(spec.PodID) + "-runtime-config"
	previous, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	d.client.(*fake.Clientset).PrependReactor("update", "secrets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.(k8stesting.UpdateAction).GetObject().(metav1.Object).GetName() == name {
			return true, nil, errors.New("Secret write rejected")
		}
		return false, nil, nil
	})
	spec.MultiUser.Generation++
	if err := d.SyncStartupConfig(ctx, spec); err == nil {
		t.Fatal("Secret failure swallowed")
	}
	after, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil || after.StringData[RuntimeConfigFileName] != previous.StringData[RuntimeConfigFileName] {
		t.Fatal("failed Secret update replaced last-good")
	}
}

func TestRuntimeFileTask007_E04PermissionFailure(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("requires an unprivileged test user to enforce POSIX permissions")
	}
	spec := fileRuntimeSpec(t, "alice")
	parent := t.TempDir()
	directory := filepath.Join(parent, "runtime")
	if err := writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, RuntimeConfigFileName)
	previous, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(parent, 0o700); err != nil {
			t.Error(err)
		}
	})
	spec.MultiUser.Generation++
	err = writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid())
	if !os.IsPermission(err) && !errors.Is(err, os.ErrPermission) {
		t.Fatalf("expected real permission error, got %v", err)
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(after, previous) {
		t.Fatal("permission failure replaced last-good")
	}
}

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
