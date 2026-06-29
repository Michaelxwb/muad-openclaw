package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// Docker resource-limit formats: memory "512m"/"2g"/"2.5g"; cpus "1.5".
var (
	memPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?[bkmgBKMG]$`)
	cpuPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
)

type resourceRequest struct {
	MemLimit      string `json:"memLimit"`
	CPULimit      string `json:"cpuLimit"`
	RestartPolicy string `json:"restartPolicy"`
}

// validateResources rejects malformed values. Empty fields are allowed (they
// mean "inherit the next layer down": per-user → global → built-in default).
func validateResources(r resourceRequest) error {
	if v := strings.TrimSpace(r.MemLimit); v != "" && !memPattern.MatchString(v) {
		return errors.New("memLimit must look like 512m / 2g / 2.5g")
	}
	if v := strings.TrimSpace(r.CPULimit); v != "" && !cpuPattern.MatchString(v) {
		return errors.New("cpuLimit must be a positive number like 1.5")
	}
	if v := strings.TrimSpace(r.RestartPolicy); v != "" && !driver.IsValidRestartPolicy(v) {
		return errors.New("restartPolicy must be no / on-failure / always / unless-stopped")
	}
	return nil
}

// handleGetResources returns the global resource defaults. When unset it reports
// the built-in defaults with configured=false.
func (s *Server) handleGetResources(w http.ResponseWriter, _ *http.Request) {
	g, err := s.store.GetResourceGlobal()
	if errors.Is(err, repo.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{
			"configured":    false,
			"memLimit":      driver.DefaultMemLimit,
			"cpuLimit":      driver.DefaultCPULimit,
			"restartPolicy": driver.DefaultRestartPolicy,
		})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "read resource config")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured":    true,
		"memLimit":      orFirst(g.MemLimit, driver.DefaultMemLimit),
		"cpuLimit":      orFirst(g.CPULimit, driver.DefaultCPULimit),
		"restartPolicy": orFirst(g.RestartPolicy, driver.DefaultRestartPolicy),
	})
}

// handleSetResources persists the global resource defaults (FEAT: dynamic config).
// Takes effect on the next container create/recreate (apply/upgrade).
func (s *Server) handleSetResources(w http.ResponseWriter, r *http.Request) {
	var req resourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	if err := validateResources(req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, err.Error())
		return
	}
	if err := s.store.SetResourceGlobal(repo.ResourceConfig{
		MemLimit:      strings.TrimSpace(req.MemLimit),
		CPULimit:      strings.TrimSpace(req.CPULimit),
		RestartPolicy: strings.TrimSpace(req.RestartPolicy),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "save resource config")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true})
}

// handleSetUserResources stores per-user resource overrides (empty = inherit).
func (s *Server) handleSetUserResources(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	if _, err := s.store.GetUser(userID); errors.Is(err, repo.ErrNotFound) {
		writeErr(w, http.StatusNotFound, 40401, "user not found")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "read user")
		return
	}
	var req resourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	if err := validateResources(req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, err.Error())
		return
	}
	if err := s.store.UpdateUserResources(userID,
		strings.TrimSpace(req.MemLimit), strings.TrimSpace(req.CPULimit), strings.TrimSpace(req.RestartPolicy)); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "save override")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// resolveResources computes the effective limits for a user record:
// built-in default ◁ global ◁ per-user (non-empty wins).
func (s *Server) resolveResources(u repo.User) (mem, cpu, restart string, err error) {
	mem, cpu, restart = driver.DefaultMemLimit, driver.DefaultCPULimit, driver.DefaultRestartPolicy
	g, gerr := s.store.GetResourceGlobal()
	if gerr != nil && !errors.Is(gerr, repo.ErrNotFound) {
		return "", "", "", gerr
	}
	if gerr == nil {
		mem, cpu, restart = orFirst(g.MemLimit, mem), orFirst(g.CPULimit, cpu), orFirst(g.RestartPolicy, restart)
	}
	mem, cpu, restart = orFirst(u.MemLimit, mem), orFirst(u.CPULimit, cpu), orFirst(u.RestartPolicy, restart)
	return mem, cpu, restart, nil
}

func orFirst(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return strings.TrimSpace(v)
}
