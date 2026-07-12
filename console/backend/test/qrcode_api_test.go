package test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestQRCodeTriggersLoginWhenDisconnected(t *testing.T) {
	e := newTestEnv(t)
	e.drv.channelDisconnected = true
	createWeChatPod(t, e, "pod-qr")
	assertQRCodeResponse(t, e, "/api/v1/containers/pod-qr/qrcode", false, true)
}

func TestQRCodeSkipsLoginWhenConnected(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-connected")
	assertQRCodeResponse(t, e, "/api/v1/containers/pod-connected/qrcode", true, false)
}

func TestQRCodeForceTriggersLoginWhenConnected(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-force")
	assertQRCodeResponse(t, e, "/api/v1/containers/pod-force/qrcode?force=true", false, true)
}

func TestQRCodeAllowsWechatInMultiChannelPod(t *testing.T) {
	e := newTestEnv(t)
	e.drv.channelDisconnected = true
	body := `{"podId":"pod-multi","channels":["wecom","wechat"],` +
		`"channelConfigs":{"wecom":{"botId":"bot","secret":"secret"}}}`
	createPodThroughAPI(t, e, body)
	assertQRCodeResponse(t, e, "/api/v1/containers/pod-multi/qrcode", false, true)
}

func TestQRCodeRejectsWeComOnlyPod(t *testing.T) {
	e := newTestEnv(t)
	createWeComPod(t, e, "pod-wecom-only")
	rr := e.do(http.MethodGet, "/api/v1/containers/pod-wecom-only/qrcode", "")
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "qrcode only applies") {
		t.Fatalf("wecom-only QR response = %d: %s", rr.Code, rr.Body.String())
	}
}

func assertQRCodeResponse(t *testing.T, e *testEnv, path string, connected, hasURL bool) {
	t.Helper()
	rr := e.do(http.MethodGet, path, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("QR status = %d: %s", rr.Code, rr.Body.String())
	}
	wantConnected := fmt.Sprintf(`"connected":%t`, connected)
	if !strings.Contains(rr.Body.String(), wantConnected) {
		t.Fatalf("QR response missing %s: %s", wantConnected, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "weixin.qq.com") != hasURL {
		t.Fatalf("QR URL presence mismatch, want %t: %s", hasURL, rr.Body.String())
	}
}
