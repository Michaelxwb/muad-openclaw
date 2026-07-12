package api

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestErrorLogMiddlewareRecordsSafeErrorContext(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previous) })

	handler := requestErrorLogMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Pod configuration")
	}))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/containers", strings.NewReader("secret-body"))
	request.Header.Set("X-Request-ID", "request-test-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if got := response.Header().Get("X-Request-ID"); got != "request-test-1" {
		t.Fatalf("response request ID = %q", got)
	}
	logged := output.String()
	for _, expected := range []string{
		"level=WARN", "request_id=request-test-1", "method=POST",
		`route="/api/v1/containers"`, "status=400", "code=40002",
		`message="invalid Pod configuration"`,
	} {
		if !strings.Contains(logged, expected) {
			t.Fatalf("log %q does not contain %q", logged, expected)
		}
	}
	if strings.Contains(logged, "secret-body") {
		t.Fatal("request body leaked into the error log")
	}
}
