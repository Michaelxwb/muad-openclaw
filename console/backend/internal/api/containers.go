package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// userIDPattern matches the same charset as provision-user.sh.
var userIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// reapWindow is the idle period after which a container is reaped (FEAT-08).
const reapWindow = 10 * 24 * time.Hour

const maxLogTail = 2000

// qrRawLines caps the raw QR-login output returned as a fallback.
const qrRawLines = 60

type createRequest struct {
	UserID      string      `json:"userId"`
	Channel     string      `json:"channel"`
	BotID       string      `json:"botId"`
	Secret      string      `json:"secret"`
	ImageTag    string      `json:"imageTag"`
	LLMOverride *llmRequest `json:"llmOverride"`
}

// handleCreateContainer provisions a user container (API-01, FEAT-01).
func (s *Server) handleCreateContainer(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	if !userIDPattern.MatchString(req.UserID) {
		writeErr(w, http.StatusBadRequest, 40001, "invalid userId")
		return
	}
	if req.Channel != "" && !driver.IsValidChannel(req.Channel) {
		writeErr(w, http.StatusBadRequest, 40001, "invalid channel")
		return
	}
	channel := driver.NormalizeChannel(req.Channel)
	// 企业微信用 bot 凭证；微信（个人）免凭证，登录靠日志二维码扫码。
	if channel == driver.ChannelWeCom && (req.BotID == "" || req.Secret == "") {
		writeErr(w, http.StatusBadRequest, 40001, "botId and secret are required for wecom")
		return
	}

	imageTag := req.ImageTag
	if imageTag == "" {
		imageTag = s.cfg.DefaultImage
	}
	secretEnc, err := s.cipher.Encrypt(req.Secret)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "encrypt secret")
		return
	}
	overrideEnc := ""
	if req.LLMOverride != nil {
		if overrideEnc, err = s.encodeOverride(*req.LLMOverride); err != nil {
			writeErr(w, http.StatusInternalServerError, 50001, "encode override")
			return
		}
	}

	// Reserve the user row first; the unique PK enforces E-01 atomically.
	err = s.store.CreateUser(repo.User{
		UserID: req.UserID, Channel: channel, BotID: req.BotID, SecretEnc: secretEnc,
		LLMOverride: overrideEnc, ImageTag: imageTag, State: "creating",
	})
	if errors.Is(err, repo.ErrUserExists) {
		writeErr(w, http.StatusConflict, 40901, "user already exists")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "create user record")
		return
	}

	// Clean up any leftover container with the same name (e.g. from a previous
	// failed attempt) so `docker run --name` won't conflict.
	_ = s.drv.Remove(r.Context(), req.UserID, true)

	spec, err := s.buildSpec(req, imageTag)
	if err != nil {
		_ = s.store.UpdateUserState(req.UserID, "error")
		writeErr(w, http.StatusInternalServerError, 50001, "assemble spec: "+err.Error())
		return
	}
	if err := s.drv.Create(r.Context(), spec, randomToken()); err != nil {
		// Keep the DB record so the user can see the failure and retry/delete.
		_ = s.store.UpdateUserState(req.UserID, "error")
		writeErr(w, http.StatusInternalServerError, 50001, "create container: "+err.Error())
		return
	}
	_ = s.store.UpdateUserState(req.UserID, "running")
	writeJSON(w, http.StatusOK, map[string]any{"userId": req.UserID, "state": "running"})
}

// handleDeleteContainer removes a container; deleteVolume opts into state loss.
func (s *Server) handleDeleteContainer(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	deleteVolume, _ := strconv.ParseBool(r.URL.Query().Get("deleteVolume"))

	if _, err := s.store.GetUser(userID); errors.Is(err, repo.ErrNotFound) {
		writeErr(w, http.StatusNotFound, 40401, "user not found")
		return
	}
	if err := s.drv.Remove(r.Context(), userID, !deleteVolume); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "remove container: "+err.Error())
		return
	}
	if err := s.store.DeleteUser(userID); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "delete user record")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "deleted": true})
}

type containerView struct {
	UserID           string     `json:"userId"`
	Channel          string     `json:"channel"`
	State            string     `json:"state"`
	ImageTag         string     `json:"imageTag"`
	CPUPercent       float64    `json:"cpuPercent"`
	MemMiB           int        `json:"memMiB"`
	ChannelConnected bool       `json:"channelConnected"`
	LastActiveAt     *time.Time `json:"lastActiveAt,omitempty"`
	ReapInSeconds    *int64     `json:"reapInSeconds,omitempty"`
	// Per-user resource overrides (empty = inherit global). For the override editor.
	MemLimit      string `json:"memLimit"`
	CPULimit      string `json:"cpuLimit"`
	RestartPolicy string `json:"restartPolicy"`
}

// handleListContainers returns the user list merged with live state and the
// collector's cached metrics (API-02). Metrics read the cache, not live probes.
// Returns ALL users (unpaginated): the status/connection filters are computed
// from live-merged data (not stored in SQL), so filtering+pagination happens
// client-side. Container counts are bounded by host capacity.
func (s *Server) handleListContainers(w http.ResponseWriter, r *http.Request) {
	users, total, err := s.store.ListUsers(0, 0)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "list users")
		return
	}
	// driver.List returns all muad-oc-* containers (docker ps -a). listOK lets us
	// tell "container absent" (→ gone) apart from "list failed" (→ keep DB state).
	live := map[string]driver.ContainerInfo{}
	listOK := false
	if infos, err := s.drv.List(r.Context()); err == nil {
		listOK = true
		for _, i := range infos {
			live[i.UserID] = i
		}
	}

	views := make([]containerView, 0, len(users))
	for _, u := range users {
		v := containerView{
			UserID: u.UserID, Channel: driver.NormalizeChannel(u.Channel),
			State: u.State, ImageTag: u.ImageTag,
			MemLimit: u.MemLimit, CPULimit: u.CPULimit, RestartPolicy: u.RestartPolicy,
		}
		if l, ok := live[u.UserID]; ok && l.State != "" {
			v.State = l.State
		} else if listOK {
			// DB record exists but no actual container (deleted out-of-band) → 已删除.
			v.State = "missing"
		}
		if v.State != "missing" {
			s.fillMetrics(&v, u.UserID)
		}
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": total})
}

func (s *Server) fillMetrics(v *containerView, userID string) {
	if snap, ok := s.cache.Get(userID); ok {
		v.CPUPercent = snap.CPUPercent
		v.MemMiB = snap.MemMiB
		v.ChannelConnected = snap.ChannelConnected
		if !snap.Healthy {
			v.State = "unhealthy"
		}
		if !snap.LastActiveAt.IsZero() {
			t := snap.LastActiveAt
			v.LastActiveAt = &t
		}
		// 回收倒计时基于真实消息活跃（收/发），有持续对话就刷新、永不进入可回收；
		// 无消息活跃数据（如 wecom 仅暴露启动时间）不显示倒计时，也不判定可回收。
		if !snap.LastMessageAt.IsZero() {
			eta := int64(reapWindow.Seconds()) - int64(time.Since(snap.LastMessageAt).Seconds())
			v.ReapInSeconds = &eta
		}
	}
}

// handleLogs tails a container's logs (API-04), capped at maxLogTail lines.
// Prefers openclaw's channel logs (the gateway log file) which include channel
// message/conversation records; falls back to container stdout (`docker logs`)
// when the gateway CLI is unavailable (e.g. gateway not yet up).
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
	if tail <= 0 {
		tail = 200
	}
	if tail > maxLogTail {
		tail = maxLogTail
	}
	out, err := s.drv.Exec(r.Context(), userID, "openclaw", "channels", "logs", "--lines", strconv.Itoa(tail))
	if err != nil || strings.TrimSpace(out) == "" {
		out, err = s.drv.Logs(r.Context(), userID, tail)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, 50001, "read logs: "+err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "tail": tail, "logs": out})
}

// qrLoginURLPattern matches the WeChat login URL the weixin plugin prints
// (e.g. https://liteapp.weixin.qq.com/q/<id>?qrcode=...). The newest match wins.
var qrLoginURLPattern = regexp.MustCompile(`https?://[^\s"'）)]*(?:weixin|wechat|wx\.qq)[^\s"'）)]*`)

// weixinLoginScript (re)triggers the WeChat QR login inside the container and
// returns its output (ASCII QR + fallback URL). WeChat login is NOT automatic on
// startup — it is started on demand by `openclaw channels login`. We run it
// detached (setsid) so it stays alive waiting for the user to scan, capture its
// output to a file, and reuse a fresh capture (<90s) to avoid spawning duplicate
// login sessions on refresh. pgrep is intentionally avoided: it would also match
// this wrapper's own command line.
const weixinLoginScript = `F=/tmp/muad-wx-qr.out
if [ -f "$F" ] && grep -q "weixin.qq.com" "$F" 2>/dev/null && [ $(( $(date +%s) - $(stat -c %Y "$F") )) -lt 90 ]; then
  cat "$F"; exit 0
fi
: > "$F"
setsid openclaw channels login --channel openclaw-weixin >"$F" 2>&1 &
for i in $(seq 1 20); do grep -q "weixin.qq.com" "$F" 2>/dev/null && break; sleep 1; done
cat "$F" 2>/dev/null`

// handleQRCode triggers the WeChat QR login and returns the login URL (render as
// a scannable QR) plus the raw output (fallback for the ASCII-art QR). Only valid
// for wechat-channel containers — WeChat has no bot credentials; the admin scans
// the QR to authorize.
func (s *Server) handleQRCode(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	u, err := s.store.GetUser(userID)
	if errors.Is(err, repo.ErrNotFound) {
		writeErr(w, http.StatusNotFound, 40401, "user not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "get user")
		return
	}
	if driver.NormalizeChannel(u.Channel) != driver.ChannelWeChat {
		writeErr(w, http.StatusBadRequest, 40001, "qrcode only applies to the wechat channel")
		return
	}

	// Already logged in? Don't (re)trigger login — that would keep rotating QR
	// codes and risk a duplicate session. Report connected and skip the QR.
	if statusOut, serr := s.drv.Exec(r.Context(), userID, "openclaw", "channels", "status", "--json"); serr == nil {
		if st, perr := gateway.ParseStatus([]byte(statusOut)); perr == nil && st.ChannelConnected {
			writeJSON(w, http.StatusOK, map[string]any{
				"userId":    userID,
				"connected": true,
				"loginUrl":  "",
				"raw":       "",
			})
			return
		}
	}

	out, err := s.drv.Exec(r.Context(), userID, "sh", "-c", weixinLoginScript)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "trigger wechat login: "+err.Error())
		return
	}
	matches := qrLoginURLPattern.FindAllString(out, -1)
	loginURL := ""
	if len(matches) > 0 {
		loginURL = matches[len(matches)-1] // newest
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"userId":    userID,
		"connected": false,
		"loginUrl":  loginURL,
		"raw":       tailLines(out, qrRawLines),
	})
}

// tailLines returns the last n non-empty-trimmed lines of s.
func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// --- LLM assembly helpers ---

// buildSpec assembles the driver spec with the effective (decrypted) LLM and
// resource limits. At create time there is no per-user override yet, so
// resources resolve to global ◁ built-in default.
func (s *Server) buildSpec(req createRequest, imageTag string) (driver.UserSpec, error) {
	eff, err := s.effectiveLLM(req.LLMOverride)
	if err != nil {
		return driver.UserSpec{}, err
	}
	mem, cpu, restart, err := s.resolveResources(repo.User{})
	if err != nil {
		return driver.UserSpec{}, err
	}
	return driver.UserSpec{
		UserID: req.UserID, Channel: driver.NormalizeChannel(req.Channel),
		BotID: req.BotID, Secret: req.Secret,
		ImageTag: imageTag, LLM: eff,
		MemLimit: mem, CPULimit: cpu, RestartPolicy: restart,
	}, nil
}

// effectiveLLM merges the decrypted global default with an optional override.
func (s *Server) effectiveLLM(override *llmRequest) (driver.LlmConfig, error) {
	global, err := s.globalLLM()
	if err != nil {
		return driver.LlmConfig{}, err
	}
	if override == nil {
		return global, nil
	}
	return driver.MergeLLM(global, llmConfigFromReq(*override)), nil
}

// globalLLM reads and decrypts the global LLM; a missing config yields a zero
// value (image baseline defaults then apply).
func (s *Server) globalLLM() (driver.LlmConfig, error) {
	g, err := s.store.GetLLMGlobal()
	if errors.Is(err, repo.ErrNotFound) {
		return driver.LlmConfig{}, nil
	}
	if err != nil {
		return driver.LlmConfig{}, err
	}
	key, err := s.cipher.Decrypt(g.APIKeyEnc)
	if err != nil {
		return driver.LlmConfig{}, err
	}
	return driver.LlmConfig{Provider: g.Provider, BaseURL: g.BaseURL, APIKey: key, Model: g.Model}, nil
}

// encodeOverride serializes and encrypts a per-user override for storage.
func (s *Server) encodeOverride(req llmRequest) (string, error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	return s.cipher.Encrypt(string(raw))
}

func llmConfigFromReq(r llmRequest) driver.LlmConfig {
	return driver.LlmConfig{Provider: r.Provider, BaseURL: r.BaseURL, APIKey: r.APIKey, Model: r.Model}
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
