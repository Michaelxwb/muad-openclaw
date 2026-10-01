package driver

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestRuntimeFileTask006_S12AtomicPermissions(t *testing.T) {
	spec := fileRuntimeSpec(t, "alice")
	directory := filepath.Join(t.TempDir(), "runtime")
	if err := writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, RuntimeConfigFileName)
	assertFileMode(t, directory, 0o700)
	assertFileMode(t, file, 0o600)
	assertRuntimeOwner(t, directory)
	assertRuntimeOwner(t, file)
	old, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Error(err)
		}
	})
	spec.MultiUser.Generation++
	if err := writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(old, updated) {
		t.Fatal("new path still reads old inode")
	}
	previous, err := os.ReadFile(file + ".previous")
	if err != nil || !bytes.Equal(previous, old) {
		t.Fatal("last-good backup lost")
	}
	assertFileMode(t, file+".previous", 0o600)
	buffer := make([]byte, len(old))
	if _, err := handle.Read(buffer); err != nil || !bytes.Equal(buffer, old) {
		t.Fatal("replacement was not atomic")
	}
}

func assertRuntimeOwner(t *testing.T, file string) {
	t.Helper()
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("filesystem owner unavailable")
	}
	if int(stat.Uid) != os.Getuid() || int(stat.Gid) != os.Getgid() {
		t.Fatal("runtime owner differs from requested UID/GID")
	}
}

func TestRuntimeFileTask006_S12FailuresKeepLastGood(t *testing.T) {
	spec := fileRuntimeSpec(t, "alice")
	directory := filepath.Join(t.TempDir(), "runtime")
	if err := writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, RuntimeConfigFileName)
	old, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	spec.MultiUser.Generation = 0
	if err := writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("invalid DTO accepted")
	}
	spec.MultiUser.Generation = 8
	if err := os.Mkdir(file+".previous", 0o700); err != nil {
		t.Fatal(err)
	}
	err = writeRuntimeFile(directory, spec.MultiUser, os.Getuid(), os.Getgid())
	if err == nil {
		t.Fatal("backup I/O failure ignored")
	}
	if strings.Contains(err.Error(), "apiKey") {
		t.Fatal("diagnostic leaks DTO")
	}
	after, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(after, old) {
		t.Fatal("failed candidate replaced last-good")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".runtime-") {
			t.Fatal("temporary config leaked")
		}
	}
}

func assertFileMode(t *testing.T, file string, expected os.FileMode) {
	t.Helper()
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != expected {
		t.Fatalf("mode for %s = %o, want %o", file, info.Mode().Perm(), expected)
	}
}
