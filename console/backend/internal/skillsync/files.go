package skillsync

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var skillNameRegexp = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

func resolvePublicSkillRoot(publicRoot string) (string, error) {
	root := filepath.Clean(strings.TrimSpace(publicRoot))
	if root == "" {
		return "", errors.New("empty public Skill root")
	}
	if filepath.IsAbs(root) {
		return root, nil
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve public Skill root: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func buildSkillDirectoryBundle(sourceDir, skillName string) ([]byte, error) {
	name := strings.TrimSpace(skillName)
	if !skillNameRegexp.MatchString(name) {
		return nil, errors.New("invalid skill name")
	}
	root := filepath.Clean(strings.TrimSpace(sourceDir))
	if root == "" || root == "." {
		return nil, errors.New("empty Skill directory")
	}
	if stat, err := os.Stat(root); err != nil {
		return nil, fmt.Errorf("stat Skill directory: %w", err)
	} else if !stat.IsDir() {
		return nil, errors.New("Skill source is not a directory")
	}
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(root, func(item string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return addSkillDirectoryBundlePath(tw, root, item, entry, name)
	})
	if err != nil {
		_ = tw.Close()
		_ = gz.Close()
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("close Skill archive: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("close Skill gzip: %w", err)
	}
	return out.Bytes(), nil
}

func addSkillDirectoryBundlePath(
	tw *tar.Writer, root, item string, entry fs.DirEntry, skillName string,
) error {
	relative, err := filepath.Rel(root, item)
	if err != nil {
		return err
	}
	archiveName := strings.Trim(strings.ReplaceAll(filepath.ToSlash(relative), "\\", "/"), "/")
	if archiveName == "." || archiveName == "" {
		archiveName = skillName
	} else {
		archiveName = path.Join(skillName, archiveName)
	}
	if err := safeArchivePath(archiveName); err != nil {
		return err
	}
	info, err := entry.Info()
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Skill source must not contain symlinks")
	}
	if entry.IsDir() {
		return writeSkillDirectoryBundleHeader(tw, archiveName+"/", info, tar.TypeDir)
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	if err := writeSkillDirectoryBundleHeader(tw, archiveName, info, tar.TypeReg); err != nil {
		return err
	}
	file, err := os.Open(item)
	if err != nil {
		return fmt.Errorf("open Skill file: %w", err)
	}
	defer file.Close()
	_, err = io.Copy(tw, file)
	return err
}

func safeArchivePath(name string) error {
	normalized := strings.ReplaceAll(name, "\\", "/")
	if normalized == "" || strings.HasPrefix(normalized, "/") || strings.Contains(normalized, ":") {
		return errors.New("bundle contains an invalid path")
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return errors.New("bundle contains a parent path segment")
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == ".." {
			return errors.New("bundle contains a parent path segment")
		}
	}
	return nil
}

func writeSkillDirectoryBundleHeader(
	tw *tar.Writer, name string, info fs.FileInfo, typ byte,
) error {
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = name
	header.Typeflag = typ
	return tw.WriteHeader(header)
}

func copySkillDirectory(source, target string) error {
	return filepath.WalkDir(source, func(item string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return errors.New("bundle must not contain symlinks")
		}
		relative, err := filepath.Rel(source, item)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o700)
		}
		sourceFile, err := os.Open(item)
		if err != nil {
			return fmt.Errorf("open Skill file: %w", err)
		}
		defer sourceFile.Close()
		return writeCopiedFile(destination, sourceFile)
	})
}

func writeCopiedFile(target string, source io.Reader) error {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create Skill file: %w", err)
	}
	defer file.Close()
	if _, err := io.Copy(file, source); err != nil {
		return fmt.Errorf("copy Skill file: %w", err)
	}
	return nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
