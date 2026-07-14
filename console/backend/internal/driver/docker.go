package driver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// DockerDriver drives single-host Docker via the `docker` CLI. Credentials are
// passed through a 0600 --env-file (never argv) to avoid leakage via `ps`.
// Gateway ports are never published; the console reaches each container by name
// on the shared network (§3.2).
type DockerDriver struct {
	network   string // shared docker network (MUAD_NET)
	skillsDir string // host path to Console-managed skills storage
	runtime   RuntimeOptions
	secretDir string // Console-private host directory for Pod service-token files
	runHook   func(context.Context, []string) (string, error)
}

const (
	defaultDockerSecretDir      = "/var/lib/muad-console/runtime-secrets"
	dockerActivePublicSkillsDir = ".muad-active-public-skills"
	dockerPublicSkillsDirMode   = 0o700
)

// NewDockerDriver builds a DockerDriver.
func NewDockerDriver(network, skillsDir string, runtime RuntimeOptions) *DockerDriver {
	return &DockerDriver{
		network: network, skillsDir: skillsDir, runtime: runtime.withDefaults(),
		secretDir: defaultDockerSecretDir,
	}
}

func stateVolume(podID string) string { return ContainerName(podID) + "-state" }

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// Create launches a Pod container (detached, no published ports).
func (d *DockerDriver) Create(ctx context.Context, spec PodSpec) error {
	if !podIDPattern.MatchString(spec.PodID) || strings.TrimSpace(spec.ImageTag) == "" {
		return ErrInvalidPodSpec
	}
	if spec.MultiUser.Version != 0 {
		if err := spec.Validate(); err != nil {
			return err
		}
	}
	if err := d.ensureStateVolume(ctx, spec.PodID, spec.AdoptState); err != nil {
		return err
	}
	if err := d.ensurePublicSkillsDir(); err != nil {
		return err
	}
	secretPath, err := d.writeServiceToken(spec)
	if err != nil {
		return err
	}
	envFile, cleanup, err := writeEnvFile(BuildEnv(spec))
	if err != nil {
		return err
	}
	defer cleanup()
	args := d.createArgs(spec, envFile, secretPath)
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

// UpdateSpec refreshes the bind-mounted service-token file in place. Docker env
// changes still require explicit Remove+Create; channel hot reloads continue to
// use ExecStdin and do not unexpectedly restart the workload.
func (d *DockerDriver) UpdateSpec(ctx context.Context, podID string, spec PodSpec) error {
	_ = ctx
	if podID != spec.PodID {
		return ErrInvalidPodSpec
	}
	_, err := d.writeServiceToken(spec)
	return err
}

func (d *DockerDriver) UpdateServiceToken(_ context.Context, podID string, secret SecretFileSpec) error {
	if secret.ContainerPath != PodServiceTokenPath || secret.Value == "" {
		return ErrInvalidPodSpec
	}
	_, err := d.writeServiceToken(PodSpec{PodID: podID, ServiceToken: secret})
	return err
}

// Remove force-removes the container; when !keepState the state volume is
// deleted too (RULE-02 "删卷" is an explicit opt-in).
func (d *DockerDriver) Remove(ctx context.Context, podID string, keepState bool) error {
	// Idempotent: tolerate an already-removed container/volume so an orphaned
	// DB record (container deleted out-of-band) can still be cleaned up.
	if _, err := d.run(ctx, "rm", "-f", ContainerName(podID)); err != nil && !isAbsentErr(err) {
		return err
	}
	if err := d.removeServiceToken(podID); err != nil {
		return err
	}
	if !keepState {
		if _, err := d.run(ctx, "volume", "rm", stateVolume(podID)); err != nil && !isAbsentErr(err) {
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
			PodID:    strings.TrimPrefix(p.Names, "muad-oc-"),
			UserID:   strings.TrimPrefix(p.Names, "muad-oc-"),
			State:    MapDockerState(p.State),
			ImageTag: p.Image,
		})
	}
	return infos, nil
}

func (d *DockerDriver) ensureStateVolume(ctx context.Context, podID string, adopt bool) error {
	name := stateVolume(podID)
	if _, err := d.run(ctx, "volume", "inspect", name); err == nil {
		if !adopt {
			return ErrRetainedState
		}
		return nil
	} else if !isAbsentErr(err) {
		return err
	}
	_, err := d.run(ctx, "volume", "create", "--label", "muad.pod-id="+podID, name)
	return err
}

func (d *DockerDriver) createArgs(spec PodSpec, envFile, secretPath string) []string {
	resource := spec.Resource
	runtime := d.runtime.withDefaults()
	args := []string{
		"run", "-d", "--name", ContainerName(spec.PodID),
		"--restart", orDefault(resource.RestartPolicy, fallbackRestartPolicy),
		"--env-file", envFile, "-e", "TZ=" + runtime.Timezone,
		"-e", "OPENCLAW_STATE_DIR=" + runtime.StateDir,
		"-v", stateVolume(spec.PodID) + ":" + runtime.StateDir,
		"--memory", orDefault(resource.MemLimit, fallbackMemLimit),
		"--cpus", orDefault(resource.CPULimit, fallbackCPULimit),
	}
	if secretPath != "" {
		args = append(args, "-v", secretPath+":"+PodServiceTokenPath+":ro")
	}
	if d.network != "" {
		args = append(args, "--network", d.network)
	}
	if hostDir := d.publicSkillsHostDir(); hostDir != "" {
		args = append(args, "-v", hostDir+":"+runtime.PublicSkillsDir+":ro")
	}
	return append(args, spec.ImageTag)
}

func (d *DockerDriver) publicSkillsHostDir() string {
	root := strings.TrimSpace(d.skillsDir)
	if root == "" {
		return ""
	}
	return filepath.Join(root, dockerActivePublicSkillsDir)
}

func (d *DockerDriver) ensurePublicSkillsDir() error {
	hostDir := d.publicSkillsHostDir()
	if hostDir == "" {
		return nil
	}
	if err := os.MkdirAll(hostDir, dockerPublicSkillsDirMode); err != nil {
		return fmt.Errorf("create Docker public Skill directory: %w", err)
	}
	return os.Chmod(hostDir, dockerPublicSkillsDirMode)
}

func (d *DockerDriver) writeServiceToken(spec PodSpec) (string, error) {
	if spec.ServiceToken.Value == "" {
		return "", nil
	}
	if !podIDPattern.MatchString(spec.PodID) {
		return "", ErrInvalidPodSpec
	}
	dir := filepath.Join(d.secretDir, spec.PodID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create Pod secret directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("chmod Pod secret directory: %w", err)
	}
	path := filepath.Join(dir, "pod-service-token")
	mode := os.FileMode(spec.ServiceToken.Mode)
	if mode == 0 {
		mode = 0o400
	}
	if err := os.Chmod(path, 0o600); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("prepare Pod service token rotation: %w", err)
	}
	if err := os.WriteFile(path, []byte(spec.ServiceToken.Value), 0o600); err != nil {
		return "", fmt.Errorf("write Pod service token: %w", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		return "", fmt.Errorf("chmod Pod service token: %w", err)
	}
	if spec.ServiceToken.UID >= 0 && spec.ServiceToken.GID >= 0 {
		if err := os.Chown(path, int(spec.ServiceToken.UID), int(spec.ServiceToken.GID)); err != nil {
			return "", fmt.Errorf("chown Pod service token: %w", err)
		}
	}
	return path, nil
}

func (d *DockerDriver) removeServiceToken(podID string) error {
	path := filepath.Join(d.secretDir, podID)
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("remove Pod service token: %w", err)
	}
	return nil
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
	if d.runHook != nil {
		return d.runHook(ctx, append([]string(nil), args...))
	}
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
