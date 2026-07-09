package skillcheck

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/tools/muad-progress/internal/progress"
)

const (
	ExitOK          = 0
	ExitInvalidArgs = 2
	ExitViolations  = 3
)

type Finding struct {
	Path    string
	Level   string
	Message string
}

type Options struct {
	Root string
	Fail bool
}

type muadManifest struct {
	Name       string             `json:"name"`
	Runtime    string             `json:"runtime"`
	Mode       string             `json:"mode"`
	Entrypoint []string           `json:"entrypoint"`
	Steps      []muadManifestStep `json:"steps"`
}

type muadManifestStep struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Command []string `json:"command"`
}

func Run(args []string, stdout io.Writer, stderr io.Writer) int {
	opts, err := parseFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return ExitInvalidArgs
	}
	findings, err := Check(opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return ExitInvalidArgs
	}
	for _, finding := range findings {
		fmt.Fprintf(stdout, "%s %s: %s\n", finding.Level, finding.Path, finding.Message)
	}
	if opts.Fail && hasFailures(findings) {
		return ExitViolations
	}
	return ExitOK
}

func parseFlags(args []string) (Options, error) {
	fs := flag.NewFlagSet("muad-skill-check", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	opts := Options{}
	fs.StringVar(&opts.Root, "root", "skills", "skills root")
	fs.BoolVar(&opts.Fail, "fail", false, "return non-zero on findings")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if strings.TrimSpace(opts.Root) == "" {
		return opts, errors.New("--root is required")
	}
	return opts, nil
}

func Check(opts Options) ([]Finding, error) {
	var findings []Finding
	err := filepath.WalkDir(opts.Root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		skillDir := filepath.Dir(path)
		skillFindings, err := checkSkill(skillDir, path)
		if err != nil {
			return err
		}
		findings = append(findings, skillFindings...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return findings, nil
}

func checkSkill(skillDir string, skillFile string) ([]Finding, error) {
	content, err := readSkillContent(skillDir)
	if err != nil {
		return nil, err
	}
	lower := strings.ToLower(content)
	var findings []Finding
	isTemplate := strings.Contains(skillDir, string(filepath.Separator)+"_templates"+string(filepath.Separator))
	isBusinessSkill := containsAny(lower, []string{"xdr", "soar", "mss", "sdsp", "业务系统", "platform="})
	if !isTemplate && isBusinessSkill && !strings.Contains(lower, "muad-progress") {
		findings = append(findings, Finding{Path: skillFile, Level: "ERROR", Message: "business skill should call muad-progress"})
	}
	manifestFindings, err := checkMuadManifest(skillDir)
	if err != nil {
		return nil, err
	}
	findings = append(findings, manifestFindings...)
	if isBusinessSkill && !strings.Contains(lower, "session-manager") {
		findings = append(findings, Finding{Path: skillFile, Level: "WARN", Message: "business skill should document session-manager usage"})
	}
	for _, line := range strings.Split(content, "\n") {
		if strings.Contains(line, "muad-progress") && progress.IsSensitiveText(line) {
			findings = append(findings, Finding{Path: skillFile, Level: "ERROR", Message: "progress text appears to contain sensitive content"})
		}
	}
	return findings, nil
}

func checkMuadManifest(skillDir string) ([]Finding, error) {
	path := filepath.Join(skillDir, "muad.skill.json")
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var manifest muadManifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return []Finding{{Path: path, Level: "ERROR", Message: "muad.skill.json must be valid JSON"}}, nil
	}
	var findings []Finding
	if strings.TrimSpace(manifest.Name) == "" {
		findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "muad.skill.json name is required"})
	}
	if manifest.Runtime != "script" {
		findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "muad.skill.json runtime must be script"})
	}
	if manifest.Mode != "steps" && manifest.Mode != "entrypoint" {
		findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "muad.skill.json mode must be steps or entrypoint"})
	}
	if len(manifest.Steps) == 0 {
		findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "muad.skill.json steps are required"})
	}
	if manifest.Mode == "entrypoint" && len(manifest.Entrypoint) == 0 {
		findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "entrypoint mode requires entrypoint"})
	}
	for _, step := range manifest.Steps {
		if strings.TrimSpace(step.ID) == "" || strings.TrimSpace(step.Title) == "" {
			findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "each step requires id and title"})
			continue
		}
		if manifest.Mode == "steps" && len(step.Command) == 0 {
			findings = append(findings, Finding{Path: path, Level: "ERROR", Message: "steps mode requires command for each step"})
		}
	}
	return findings, nil
}

func readSkillContent(skillDir string) (string, error) {
	var builder strings.Builder
	err := filepath.WalkDir(skillDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "node_modules" || entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !isScannable(path) {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		builder.Write(content)
		builder.WriteByte('\n')
		return nil
	})
	return builder.String(), err
}

func isScannable(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".md", ".sh", ".py", ".js", ".mjs", ".ts", ".json", ".yaml", ".yml":
		return true
	default:
		return false
	}
}

func containsAny(value string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func hasFailures(findings []Finding) bool {
	for _, finding := range findings {
		if finding.Level == "ERROR" {
			return true
		}
	}
	return false
}
