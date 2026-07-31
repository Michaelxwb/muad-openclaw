package test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
)

func TestProbe_Success(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", req.URL.Path)
		}
		if req.Header.Get("Authorization") != "Bearer key-123" {
			return probeResponse(http.StatusUnauthorized), nil
		}
		return probeResponse(http.StatusOK), nil
	})}

	if err := llm.ProbeWithClient(context.Background(), "http://93.184.216.34/v1", "key-123", client); err != nil {
		t.Errorf("Probe success path failed: %v", err)
	}
}

func TestProbe_Unauthorized(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return probeResponse(http.StatusUnauthorized), nil
	})}

	if err := llm.ProbeWithClient(context.Background(), "http://93.184.216.34", "bad", client); err == nil {
		t.Error("expected error on 401")
	}
}

func TestProbe_AllowsPrivateTargets(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		requests++
		return probeResponse(http.StatusOK), nil
	})}

	if err := llm.ProbeWithClient(context.Background(), "http://127.0.0.1:8080", "k", client); err != nil {
		t.Errorf("Probe should allow private baseURL: %v", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestProbe_EmptyBaseURL(t *testing.T) {
	if err := llm.Probe(context.Background(), "", "k"); err == nil {
		t.Error("expected error on empty baseURL")
	}
}

func TestProbe_RejectsInvalidScheme(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		t.Fatal("invalid scheme should be rejected before the request")
		return nil, nil
	})}

	if err := llm.ProbeWithClient(context.Background(), "ftp://example.com", "k", client); err == nil {
		t.Error("expected error on invalid scheme")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func probeResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader("")),
		Header:     http.Header{},
	}
}
