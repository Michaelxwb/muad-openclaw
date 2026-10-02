package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

type uploadDeadlineWriter struct {
	http.ResponseWriter
	err   error
	clamp time.Duration
	seen  time.Time
}

func (w *uploadDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	w.seen = deadline
	if w.err != nil {
		return w.err
	}
	if w.clamp > 0 {
		deadline = time.Now().Add(w.clamp)
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func TestSkillUploadDeadlineFailureIsExplicit(t *testing.T) {
	for _, err := range []error{http.ErrNotSupported, errors.New("deadline unavailable")} {
		rr := httptest.NewRecorder()
		w := &uploadDeadlineWriter{ResponseWriter: rr, err: err}
		if setSkillUploadReadDeadline(w, httptest.NewRequest(http.MethodPost, "/upload", nil)) {
			t.Fatal("failed deadline was accepted")
		}
		assertUploadResponse(t, rr.Code, rr.Body.Bytes(), http.StatusInternalServerError, errcode.InternalSkillUploadDeadline)
	}
}

func TestSkillUploadTimeoutClassification(t *testing.T) {
	err := fmt.Errorf("multipart: %w", &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded})
	if multipartParseCode(err) != errcode.SkillUploadTimeout {
		t.Fatal("wrapped socket timeout was not recognized")
	}
	for _, lang := range []string{"zh", "en"} {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/upload", nil)
		req.Header.Set("Accept-Language", lang)
		withLanguage(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeErrDetail(w, r, multipartParseCode(err), multipartParseDetail(err, 1024, langFrom(r.Context())))
		})).ServeHTTP(rr, req)
		assertUploadResponse(t, rr.Code, rr.Body.Bytes(), http.StatusRequestTimeout, errcode.SkillUploadTimeout)
		wantMessage := "Skill 包上传超时，请检查网络后重试"
		if lang == "en" {
			wantMessage = "Skill bundle upload timed out; check your network and retry"
		}
		if strings.Contains(rr.Body.String(), "tcp") || !strings.Contains(rr.Body.String(), wantMessage) {
			t.Fatalf("unexpected timeout diagnostic: %s", rr.Body.String())
		}
	}
	if multipartParseCode(errors.New("malformed multipart")) != errcode.InvalidRequestBody {
		t.Fatal("malformed body mapping changed")
	}
}

func TestSkillUploadSocketReadDeadline(t *testing.T) {
	for _, kind := range []string{"ordinary", "public", "private", "timeout"} {
		t.Run(kind, func(t *testing.T) { exerciseUploadSocket(t, kind) })
	}
}

func exerciseUploadSocket(t *testing.T, kind string) {
	t.Helper()
	observed := make(chan time.Duration, 1)
	s := &Server{cfg: &config.Config{SkillMaxUploadBundleBytes: 1024}}
	handler := requestErrorLogMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadlineWriter := &uploadDeadlineWriter{ResponseWriter: w}
		if kind == "timeout" {
			deadlineWriter.clamp = 50 * time.Millisecond
		}
		wrapped := &statusRecorder{ResponseWriter: deadlineWriter}
		if kind == "ordinary" {
			_, err := io.ReadAll(r.Body)
			if !isSkillUploadTimeout(err) {
				writeErr(w, r, errcode.InternalError)
				return
			}
			writeErr(w, r, errcode.SkillUploadTimeout)
			return
		}
		var ok bool
		if kind == "private" {
			_, ok = s.readPrivateSkillUpload(wrapped, r)
		} else {
			_, ok = s.readPublicSkillUpload(wrapped, r)
		}
		observed <- time.Until(deadlineWriter.seen)
		if r.MultipartForm != nil {
			if err := r.MultipartForm.RemoveAll(); err != nil {
				t.Errorf("cleanup multipart: %v", err)
			}
		}
		if ok {
			writeJSON(w, http.StatusOK, nil)
		}
	}))
	status, body := delayedUpload(t, handler)
	assertSocketUploadResult(t, kind, status, body, observed)
}

func assertSocketUploadResult(t *testing.T, kind string, status int, body []byte, observed <-chan time.Duration) {
	t.Helper()
	if kind == "ordinary" || kind == "timeout" {
		assertUploadResponse(t, status, body, http.StatusRequestTimeout, errcode.SkillUploadTimeout)
	} else {
		assertUploadResponse(t, status, body, http.StatusOK, 0)
	}
	if kind != "ordinary" {
		remaining := <-observed
		if remaining < skillUploadReadTimeout-time.Second || remaining > skillUploadReadTimeout {
			t.Fatalf("upload deadline remaining = %s", remaining)
		}
	}
}

func uploadForm(t *testing.T) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("bundle", "fixture.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("fixture")); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), form.FormDataContentType()
}

func delayedUpload(t *testing.T, handler http.Handler) (int, []byte) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config.ReadTimeout = 50 * time.Millisecond
	server.Start()
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	body, contentType := uploadForm(t)
	if _, err := fmt.Fprintf(conn, "POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", contentType, len(body)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := conn.Write(body); err != nil {
		t.Logf("server stopped receiving expired request: %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, result
}

func assertUploadResponse(t *testing.T, status int, body []byte, wantStatus, wantCode int) {
	t.Helper()
	var envelope struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	if status != wantStatus || envelope.Code != wantCode {
		t.Fatalf("response = %d/%d %s; want %d/%d", status, envelope.Code, body, wantStatus, wantCode)
	}
}
