package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDailyWriterCreatesDateDirectoriesAndRotates(t *testing.T) {
	root := t.TempDir()
	current := time.Date(2026, 7, 12, 23, 59, 0, 0, time.Local)
	writer, err := NewDailyWriter(Options{Directory: root, Now: func() time.Time { return current }})
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}
	t.Cleanup(func() { _ = writer.Close() })
	if _, err := writer.Write([]byte("day-one\n")); err != nil {
		t.Fatalf("write first day: %v", err)
	}
	current = current.Add(2 * time.Minute)
	if _, err := writer.Write([]byte("day-two\n")); err != nil {
		t.Fatalf("write second day: %v", err)
	}

	assertLogFile(t, filepath.Join(root, "2026-07-12", logFileName), "day-one\n")
	assertLogFile(t, filepath.Join(root, "2026-07-13", logFileName), "day-two\n")
}

func TestDailyWriterSerializesConcurrentWrites(t *testing.T) {
	root := t.TempDir()
	current := time.Date(2026, 7, 12, 12, 0, 0, 0, time.Local)
	writer, err := NewDailyWriter(Options{Directory: root, Now: func() time.Time { return current }})
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}
	const writes = 50
	var wait sync.WaitGroup
	errors := make(chan error, writes)
	for index := 0; index < writes; index++ {
		wait.Add(1)
		go func(value int) {
			defer wait.Done()
			_, err := fmt.Fprintf(writer, "entry-%02d\n", value)
			errors <- err
		}(index)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("concurrent write: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(root, "2026-07-12", logFileName))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if got := strings.Count(string(content), "entry-"); got != writes {
		t.Fatalf("log entries = %d, want %d", got, writes)
	}
}

func assertLogFile(t *testing.T, path, expected string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(content) != expected {
		t.Fatalf("content of %s = %q, want %q", path, content, expected)
	}
}
