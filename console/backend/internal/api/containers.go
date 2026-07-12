package api

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
)

const (
	maxLogTail = 2000
	qrRawLines = 60
)

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	podID := r.PathValue("podId")
	if _, err := s.store.GetPod(podID); err != nil {
		writeRepoError(w, err)
		return
	}
	tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
	if tail <= 0 {
		tail = 200
	}
	if tail > maxLogTail {
		tail = maxLogTail
	}
	out, err := s.drv.Exec(r.Context(), podID, "openclaw", "channels", "logs", "--lines", strconv.Itoa(tail))
	if err != nil || strings.TrimSpace(out) == "" {
		out, err = s.drv.Logs(r.Context(), podID, tail)
		if err != nil {
			writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "read Pod logs failed")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": podID, "tail": tail, "logs": auditlog.RedactSensitiveText(out),
	})
}

var qrLoginURLPattern = regexp.MustCompile(`https?://[^\s"'）)]*(?:weixin|wechat|wx\.qq)[^\s"'）)]*`)

const weixinLoginScript = `F=/tmp/muad-wx-qr.out
if [ "${MUAD_FORCE_QR:-0}" != "1" ] && [ -f "$F" ] && grep -q "weixin.qq.com" "$F" 2>/dev/null && [ $(( $(date +%s) - $(stat -c %Y "$F") )) -lt 90 ]; then
  cat "$F"; exit 0
fi
: > "$F"
setsid openclaw channels login --channel ` + driver.OpenClawChannelWeChat + ` >"$F" 2>&1 &
for i in $(seq 1 20); do grep -q "weixin.qq.com" "$F" 2>/dev/null && break; sleep 1; done
cat "$F" 2>/dev/null`

func (s *Server) handleQRCode(w http.ResponseWriter, r *http.Request) {
	podID := r.PathValue("podId")
	force, _ := strconv.ParseBool(r.URL.Query().Get("force"))
	pod, err := s.store.GetPod(podID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	channels, _, err := s.decodeChannelSettings(pod)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode channel configuration")
		return
	}
	if !containsChannel(channels, driver.ChannelWeChat) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "qrcode only applies to the wechat channel")
		return
	}
	if !force && s.wechatConnected(r, podID) {
		writeJSON(w, http.StatusOK, map[string]any{
			"podId": podID, "connected": true, "loginUrl": "", "raw": "",
		})
		return
	}
	s.writeWechatLogin(w, r, podID, force)
}

func containsChannel(channels []string, target string) bool {
	for _, channel := range channels {
		if channel == target {
			return true
		}
	}
	return false
}

func (s *Server) wechatConnected(r *http.Request, podID string) bool {
	out, err := s.drv.Exec(r.Context(), podID, "openclaw", "channels", "status", "--json")
	if err != nil {
		return false
	}
	status, err := gateway.ParseStatus([]byte(out))
	if err != nil {
		return false
	}
	return status.ChannelStatuses[driver.OpenClawChannelWeChat]
}

func (s *Server) writeWechatLogin(w http.ResponseWriter, r *http.Request, podID string, force bool) {
	script := weixinLoginScript
	if force {
		script = "MUAD_FORCE_QR=1\n" + script
	}
	out, err := s.drv.Exec(r.Context(), podID, "sh", "-c", script)
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "trigger wechat login failed")
		return
	}
	matches := qrLoginURLPattern.FindAllString(out, -1)
	loginURL := ""
	if len(matches) > 0 {
		loginURL = matches[len(matches)-1]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": podID, "connected": false, "loginUrl": loginURL,
		"raw": tailLines(out, qrRawLines),
	})
}

func tailLines(value string, limit int) string {
	lines := strings.Split(strings.TrimRight(value, "\n"), "\n")
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return strings.Join(lines, "\n")
}
