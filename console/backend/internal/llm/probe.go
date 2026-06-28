// Package llm provides an OpenAI-compatible connectivity check used before
// saving an LLM configuration (FEAT-04 / E-02).
package llm

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// probeTimeout bounds a single connectivity check (§3.2 external dependency).
const probeTimeout = 8 * time.Second

// Probe verifies an OpenAI-compatible endpoint is reachable and the API key is
// accepted by issuing GET <baseURL>/models. A 2xx response means success.
func Probe(ctx context.Context, baseURL, apiKey string) error {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return fmt.Errorf("baseURL is required")
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("unreachable: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// Reached the server, but the key was rejected.
		return fmt.Errorf("API key rejected (HTTP %d)", resp.StatusCode)
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed:
		// Endpoint is up but lacks a /models route (some OpenAI-compatible
		// gateways) — treat as reachable rather than a false "unreachable".
		return nil
	default:
		return fmt.Errorf("endpoint returned HTTP %d", resp.StatusCode)
	}
}
