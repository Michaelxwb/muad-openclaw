// Package llm provides an OpenAI-compatible connectivity check used before
// saving an LLM configuration (FEAT-04 / E-02).
package llm

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// probeTimeout bounds a single connectivity check (§3.2 external dependency).
const probeTimeout = 8 * time.Second

// Probe verifies an OpenAI-compatible endpoint is reachable and the API key is
// accepted by issuing GET <baseURL>/models. A 2xx response means success.
func Probe(ctx context.Context, baseURL, apiKey string) error {
	return ProbeWithClient(ctx, baseURL, apiKey, secureProbeClient())
}

// ProbeWithClient runs the same endpoint check with an injected client for
// deterministic tests. The target URL is still validated before the request.
func ProbeWithClient(ctx context.Context, baseURL, apiKey string, client *http.Client) error {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return fmt.Errorf("baseURL is required")
	}
	if err := validateProbeURL(base); err != nil {
		return err
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
	if client == nil {
		client = secureProbeClient()
	}

	resp, err := client.Do(req)
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

func secureProbeClient() *http.Client {
	if defaults, ok := http.DefaultTransport.(*http.Transport); ok {
		return &http.Client{
			Transport:     secureProbeTransport(defaults.Clone()),
			Timeout:       probeTimeout,
			CheckRedirect: validateProbeRedirect,
		}
	}
	return &http.Client{
		Transport:     http.DefaultTransport,
		Timeout:       probeTimeout,
		CheckRedirect: validateProbeRedirect,
	}
}

func secureProbeTransport(transport *http.Transport) http.RoundTripper {
	dialer := &net.Dialer{Timeout: probeTimeout}
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ip, err := resolvePublicProbeIP(ctx, host)
		if err != nil {
			return nil, err
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
	}
	return transport
}

func validateProbeRedirect(req *http.Request, _ []*http.Request) error {
	return validateProbeURL(req.URL.String())
}

func validateProbeURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("baseURL must use http or https")
	}
	if parsed.Hostname() == "" {
		return fmt.Errorf("baseURL host is required")
	}
	if ip, err := netip.ParseAddr(parsed.Hostname()); err == nil && !publicProbeIP(ip) {
		return fmt.Errorf("baseURL host is not allowed")
	}
	return nil
}

func resolvePublicProbeIP(ctx context.Context, host string) (net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return validateResolvedProbeIP(ip)
	}
	resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, candidate := range resolved {
		if ip, err := validateResolvedProbeIP(candidate.IP); err == nil {
			return ip, nil
		}
	}
	return nil, fmt.Errorf("baseURL host is not allowed")
}

func validateResolvedProbeIP(ip net.IP) (net.IP, error) {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok || !publicProbeIP(addr.Unmap()) {
		return nil, fmt.Errorf("baseURL host is not allowed")
	}
	return ip, nil
}

func publicProbeIP(ip netip.Addr) bool {
	return ip.IsValid() && ip.IsGlobalUnicast() && !ip.IsPrivate() &&
		!ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}
