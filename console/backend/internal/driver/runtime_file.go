package driver

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func writeRuntimeFile(directory string, config RuntimeConfigV1, uid, gid int) error {
	if err := config.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("serialize startup config: %w", err)
	}
	if err := prepareRuntimeDirectory(directory, uid, gid); err != nil {
		return err
	}
	target := filepath.Join(directory, RuntimeConfigFileName)
	previous, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read previous startup config: %w", err)
	}
	if err == nil {
		if err := atomicRuntimeWrite(target+".previous", previous, uid, gid); err != nil {
			return err
		}
	}
	return atomicRuntimeWrite(target, raw, uid, gid)
}

func prepareRuntimeDirectory(directory string, uid, gid int) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create runtime directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("inspect runtime directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("runtime directory must be a real directory")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("chmod runtime directory: %w", err)
	}
	if err := os.Chown(directory, uid, gid); err != nil {
		return fmt.Errorf("chown runtime directory: %w", err)
	}
	return nil
}

func atomicRuntimeWrite(target string, raw []byte, uid, gid int) (resultErr error) {
	file, err := os.CreateTemp(filepath.Dir(target), ".runtime-*")
	if err != nil {
		return fmt.Errorf("create runtime temporary file: %w", err)
	}
	name := file.Name()
	defer func() {
		if err := os.Remove(name); err != nil && !os.IsNotExist(err) {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove runtime temporary file: %w", err))
		}
	}()
	if err := populateRuntimeTemporary(file, raw, uid, gid); err != nil {
		return err
	}
	if err := os.Rename(name, target); err != nil {
		return fmt.Errorf("publish startup config: %w", err)
	}
	return nil
}

func populateRuntimeTemporary(file *os.File, raw []byte, uid, gid int) (resultErr error) {
	defer func() {
		if err := file.Close(); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close runtime temporary file: %w", err))
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("chmod runtime file: %w", err)
	}
	if err := file.Chown(uid, gid); err != nil {
		return fmt.Errorf("chown runtime file: %w", err)
	}
	if _, err := file.Write(raw); err != nil {
		return fmt.Errorf("write runtime file: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync runtime file: %w", err)
	}
	return nil
}
