package driver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// DockerDriver drives single-host Docker via the `docker` CLI. Credentials are
// passed through a 0600 --env-file (never argv) to avoid leakage via `ps`.
// Gateway ports are never published; the console reaches each container by name
// on the shared network (§3.2).
type DockerDriver struct {
	network   string // shared docker network (MUAD_NET)
	skillsDir string // host path to shared skills, mounted read-only
}

// NewDockerDriver builds a DockerDriver.
func NewDockerDriver(network, skillsDir string) *DockerDriver {
	return &DockerDriver{network: network, skillsDir: skillsDir}
}

func stateVolume(userID string) string { return ContainerName(userID) + "-state" }

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// Create launches a user container (detached, no published ports).
func (d *DockerDriver) Create(ctx context.Context, spec UserSpec, gatewayToken string) error {
	envFile, cleanup, err := writeEnvFile(BuildEnv(spec, gatewayToken))
	if err != nil {
		return err
	}
	defer cleanup()

	// Resolved limits with defensive fallback to the built-in defaults.
	mem := orDefault(spec.MemLimit, DefaultMemLimit)
	cpus := orDefault(spec.CPULimit, DefaultCPULimit)
	restart := orDefault(spec.RestartPolicy, DefaultRestartPolicy)

	name := ContainerName(spec.UserID)
	args := []string{
		"run", "-d", "--name", name,
		"--restart", restart,
		"--env-file", envFile,
		"-e", "TZ=Asia/Shanghai",
		"-e", "OPENCLAW_STATE_DIR=/home/node/.openclaw",
		"-v", stateVolume(spec.UserID) + ":/home/node/.openclaw",
		"--memory", mem, "--cpus", cpus,
	}
	if d.network != "" {
		args = append(args, "--network", d.network)
	}
	if d.skillsDir != "" {
		args = append(args, "-v", d.skillsDir+":/opt/openclaw-skills:ro")
	}
	args = append(args, spec.ImageTag)

	_, err = d.run(ctx, args...)
	return err
}

func (d *DockerDriver) Start(ctx context.Context, userID string) error {
	_, err := d.run(ctx, "start", ContainerName(userID))
	return err
}

func (d *DockerDriver) Stop(ctx context.Context, userID string) error {
	_, err := d.run(ctx, "stop", ContainerName(userID))
	return err
}

func (d *DockerDriver) Restart(ctx context.Context, userID string) error {
	_, err := d.run(ctx, "restart", ContainerName(userID))
	return err
}

// Remove force-removes the container; when !keepState the state volume is
// deleted too (RULE-02 "删卷" is an explicit opt-in).
func (d *DockerDriver) Remove(ctx context.Context, userID string, keepState bool) error {
	// Idempotent: tolerate an already-removed container/volume so an orphaned
	// DB record (container deleted out-of-band) can still be cleaned up.
	if _, err := d.run(ctx, "rm", "-f", ContainerName(userID)); err != nil && !isAbsentErr(err) {
		return err
	}
	if !keepState {
		if _, err := d.run(ctx, "volume", "rm", stateVolume(userID)); err != nil && !isAbsentErr(err) {
			return err
		}
	}
	return nil
}

// isAbsentErr reports whether a docker error means the target was already gone.
func isAbsentErr(err error) bool {
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "no such container") || strings.Contains(s, "no such volume") ||
		strings.Contains(s, "not found")
}

// dockerPS is one line of `docker ps --format {{json .}}`.
type dockerPS struct {
	Names string `json:"Names"`
	State string `json:"State"`
	Image string `json:"Image"`
}

// List returns container state/image for all muad-oc-* containers. Resource and
// gateway fields are filled by the collector, not here.
func (d *DockerDriver) List(ctx context.Context) ([]ContainerInfo, error) {
	out, err := d.run(ctx, "ps", "-a", "--filter", "name=muad-oc-", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	var infos []ContainerInfo
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var p dockerPS
		if err := json.Unmarshal([]byte(line), &p); err != nil {
			return nil, fmt.Errorf("parse docker ps: %w", err)
		}
		infos = append(infos, ContainerInfo{
			UserID:   strings.TrimPrefix(p.Names, "muad-oc-"),
			State:    MapDockerState(p.State),
			ImageTag: p.Image,
		})
	}
	return infos, nil
}

// StatsAll samples CPU/MEM for every muad-oc-* container in one `docker stats`
// call (avoids per-container streams; RULE-06).
func (d *DockerDriver) StatsAll(ctx context.Context) (map[string]Stats, error) {
	out, err := d.run(ctx, "stats", "--no-stream", "--format", "{{.Name}};{{.CPUPerc}};{{.MemUsage}}")
	if err != nil {
		return nil, err
	}
	result := map[string]Stats{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ";", 2)
		if len(parts) != 2 || !strings.HasPrefix(parts[0], "muad-oc-") {
			continue
		}
		st, err := ParseStats(parts[1])
		if err != nil {
			continue // skip an unparseable container rather than fail the cycle
		}
		result[strings.TrimPrefix(parts[0], "muad-oc-")] = st
	}
	return result, nil
}

// Exec runs a command inside the user's container.
func (d *DockerDriver) Exec(ctx context.Context, userID string, cmd ...string) (string, error) {
	args := append([]string{"exec", ContainerName(userID)}, cmd...)
	return d.run(ctx, args...)
}

// ExecStdin runs a command with stdin piped from the reader.
func (d *DockerDriver) ExecStdin(ctx context.Context, userID string, stdin io.Reader, cmd ...string) (string, error) {
	args := append([]string{"exec", "-i", ContainerName(userID)}, cmd...)
	return d.runStdin(ctx, stdin, args...)
}

func (d *DockerDriver) runStdin(ctx context.Context, stdin io.Reader, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.Stdin = stdin
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// Logs returns the last `tail` lines (combined stdout+stderr).
func (d *DockerDriver) Logs(ctx context.Context, userID string, tail int) (string, error) {
	if tail <= 0 {
		tail = 200
	}
	return d.run(ctx, "logs", "--tail", strconv.Itoa(tail), ContainerName(userID))
}

// Reap stops the container to free CPU/RAM while the state volume persists
// (a stopped container consumes no compute). Revive restarts it.
func (d *DockerDriver) Reap(ctx context.Context, userID string) error { return d.Stop(ctx, userID) }

func (d *DockerDriver) Revive(ctx context.Context, userID string) error { return d.Start(ctx, userID) }

// run executes a docker command, combining stderr into the error on failure.
func (d *DockerDriver) run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func writeEnvFile(env map[string]string) (path string, cleanup func(), err error) {
	f, err := os.CreateTemp("", "muad-env-*")
	if err != nil {
		return "", func() {}, err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return "", func() {}, err
	}
	var b strings.Builder
	for k, v := range env {
		fmt.Fprintf(&b, "%s=%s\n", k, v)
	}
	if _, err := f.WriteString(b.String()); err != nil {
		_ = f.Close()
		return "", func() {}, err
	}
	_ = f.Close()
	return f.Name(), func() { _ = os.Remove(f.Name()) }, nil
}

// MapDockerState normalizes a `docker ps` State to a console state value.
func MapDockerState(s string) string {
	switch strings.ToLower(s) {
	case "running":
		return "running"
	case "created":
		return "creating"
	case "exited", "dead":
		return "stopped"
	case "paused":
		return "stopped"
	default:
		return s
	}
}

// ParseStats parses "12.34%;123.4MiB / 2GiB".
func ParseStats(s string) (Stats, error) {
	parts := strings.SplitN(s, ";", 2)
	if len(parts) != 2 {
		return Stats{}, fmt.Errorf("unexpected stats format: %q", s)
	}
	cpu, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(parts[0]), "%"), 64)
	if err != nil {
		return Stats{}, fmt.Errorf("parse cpu: %w", err)
	}
	memUsed := strings.TrimSpace(strings.SplitN(parts[1], "/", 2)[0])
	mib, err := ParseMemMiB(memUsed)
	if err != nil {
		return Stats{}, err
	}
	return Stats{CPUPercent: cpu, MemMiB: mib}, nil
}

// ParseMemMiB converts a docker memory string like "123.4MiB" / "1.2GiB" to MiB.
func ParseMemMiB(s string) (int, error) {
	s = strings.TrimSpace(s)
	// docker stats uses binary units by default (GiB/MiB/KiB/B).
	units := []struct {
		suffix string
		factor float64
	}{
		{"GiB", 1024}, {"MiB", 1}, {"KiB", 1.0 / 1024}, {"B", 1.0 / 1024 / 1024},
	}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			n, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), 64)
			if err != nil {
				return 0, fmt.Errorf("parse mem %q: %w", s, err)
			}
			return int(n * u.factor), nil
		}
	}
	return 0, fmt.Errorf("unknown mem unit: %q", s)
}
