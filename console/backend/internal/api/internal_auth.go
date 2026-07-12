package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type podContextKey struct{}

func (s *Server) internalAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := parseBearerToken(r.Header.Get("Authorization"))
		if !ok {
			writeErr(w, http.StatusUnauthorized, codePodUnauthorized, "invalid Pod service token")
			return
		}
		pod, err := s.authenticatePodToken(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, codePodUnauthorized, "invalid Pod service token")
			return
		}
		ctx := context.WithValue(r.Context(), podContextKey{}, pod)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) authenticatePodToken(token string) (repo.Pod, error) {
	pod, err := s.store.FindPodByServiceTokenFingerprint(crypto.Fingerprint(token))
	if err != nil {
		return repo.Pod{}, err
	}
	plain, err := s.cipher.Decrypt(pod.ServiceTokenEnc)
	if err != nil {
		return repo.Pod{}, err
	}
	if !crypto.ConstantTimeEqual(plain, token) {
		return repo.Pod{}, errors.New("Pod service token mismatch")
	}
	return pod, nil
}

func podFromContext(ctx context.Context) (repo.Pod, bool) {
	pod, ok := ctx.Value(podContextKey{}).(repo.Pod)
	return pod, ok
}

func parseBearerToken(header string) (string, bool) {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}
