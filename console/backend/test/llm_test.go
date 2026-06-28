package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
)

func TestProbe_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer key-123" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := llm.Probe(context.Background(), srv.URL, "key-123"); err != nil {
		t.Errorf("Probe success path failed: %v", err)
	}
}

func TestProbe_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	if err := llm.Probe(context.Background(), srv.URL, "bad"); err == nil {
		t.Error("expected error on 401")
	}
}

func TestProbe_EmptyBaseURL(t *testing.T) {
	if err := llm.Probe(context.Background(), "", "k"); err == nil {
		t.Error("expected error on empty baseURL")
	}
}
