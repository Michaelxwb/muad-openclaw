// Package logging configures Console log outputs and date-partitioned files.
package logging

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	dailyLayout = "2006-01-02"
	logFileName = "console.log"
)

type Options struct {
	Directory string
	Stdout    io.Writer
	Now       func() time.Time
}

type DailyWriter struct {
	directory string
	now       func() time.Time
	mu        sync.Mutex
	date      string
	file      *os.File
}

func Configure(options Options) (io.Closer, error) {
	stdout := options.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	directory := strings.TrimSpace(options.Directory)
	if directory == "" {
		log.SetOutput(stdout)
		return nopCloser{}, nil
	}
	writer, err := NewDailyWriter(Options{Directory: directory, Now: options.Now})
	if err != nil {
		return nil, err
	}
	log.SetOutput(io.MultiWriter(stdout, writer))
	return writer, nil
}

func NewDailyWriter(options Options) (*DailyWriter, error) {
	directory := strings.TrimSpace(options.Directory)
	if directory == "" {
		return nil, errors.New("logging: directory is required")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	writer := &DailyWriter{directory: filepath.Clean(directory), now: now}
	if err := writer.rotate(now()); err != nil {
		return nil, err
	}
	return writer, nil
}

func (writer *DailyWriter) Write(value []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if err := writer.rotate(writer.now()); err != nil {
		return 0, err
	}
	written, err := writer.file.Write(value)
	if err == nil && written != len(value) {
		err = io.ErrShortWrite
	}
	return written, err
}

func (writer *DailyWriter) Close() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.file == nil {
		return nil
	}
	err := writer.file.Close()
	writer.file = nil
	return err
}

func (writer *DailyWriter) rotate(now time.Time) error {
	date := now.Format(dailyLayout)
	if writer.file != nil && writer.date == date {
		return nil
	}
	directory := filepath.Join(writer.directory, date)
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return fmt.Errorf("logging: create daily directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(directory, logFileName), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("logging: open daily file: %w", err)
	}
	if writer.file != nil {
		if closeErr := writer.file.Close(); closeErr != nil {
			cleanupErr := file.Close()
			return errors.Join(fmt.Errorf("logging: close previous daily file: %w", closeErr), cleanupErr)
		}
	}
	writer.file = file
	writer.date = date
	return nil
}

type nopCloser struct{}

func (nopCloser) Close() error { return nil }
