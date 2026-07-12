package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type serviceTokenMaterial struct {
	plain       string
	encrypted   string
	fingerprint string
	rotatedAt   time.Time
}

func (s *Server) handleRotatePodServiceToken(w http.ResponseWriter, r *http.Request) {
	podID := r.PathValue("podId")
	fingerprint, err := s.rotatePodServiceToken(r.Context(), podID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			writeRepoError(w, err)
		} else {
			writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "Pod service token rotation failed")
		}
		return
	}
	if err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: auditlog.ActionPodServiceTokenRotate,
		Target: podID, Metadata: auditlog.Metadata{PodID: podID, Fingerprint: fingerprint},
	}); err != nil {
		log.Printf("service_token_rotate_audit_failed pod=%s error=%v", podID, err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": podID, "fingerprint": crypto.DisplayFingerprint(fingerprint),
	})
}

func (s *Server) rotatePodServiceToken(ctx context.Context, podID string) (string, error) {
	pod, err := s.store.GetPod(podID)
	if err != nil {
		return "", err
	}
	old, err := s.readTokenMaterial(pod)
	if err != nil {
		return "", err
	}
	next, err := s.generateTokenMaterial()
	if err != nil {
		return "", err
	}
	running := pod.State == repo.PodStateRunning
	if running {
		if err := s.drv.Stop(ctx, podID); err != nil {
			return "", fmt.Errorf("stop Pod for token rotation: %w", err)
		}
	}
	if err := s.drv.UpdateServiceToken(ctx, podID, tokenSecret(next.plain)); err != nil {
		return "", errors.Join(err, s.rollbackToken(ctx, podID, old, running))
	}
	if err := s.store.RotatePodServiceToken(podID, next.encrypted, next.fingerprint, next.rotatedAt); err != nil {
		return "", errors.Join(err, s.rollbackToken(ctx, podID, old, running))
	}
	if running {
		if err := s.drv.Start(ctx, podID); err != nil {
			return "", errors.Join(err, s.rollbackToken(ctx, podID, old, true))
		}
	}
	if _, err := s.authenticatePodToken(next.plain); err != nil {
		return "", errors.Join(err, s.rollbackToken(ctx, podID, old, running))
	}
	return next.fingerprint, nil
}

func (s *Server) readTokenMaterial(pod repo.Pod) (serviceTokenMaterial, error) {
	plain, err := s.cipher.Decrypt(pod.ServiceTokenEnc)
	if err != nil {
		return serviceTokenMaterial{}, fmt.Errorf("decrypt current service token: %w", err)
	}
	return serviceTokenMaterial{
		plain: plain, encrypted: pod.ServiceTokenEnc,
		fingerprint: pod.ServiceTokenFingerprint, rotatedAt: pod.ServiceTokenRotatedAt,
	}, nil
}

func (s *Server) generateTokenMaterial() (serviceTokenMaterial, error) {
	plain, err := crypto.GenerateServiceToken()
	if err != nil {
		return serviceTokenMaterial{}, fmt.Errorf("generate service token: %w", err)
	}
	encrypted, err := s.cipher.Encrypt(plain)
	if err != nil {
		return serviceTokenMaterial{}, fmt.Errorf("encrypt service token: %w", err)
	}
	return serviceTokenMaterial{
		plain: plain, encrypted: encrypted, fingerprint: crypto.Fingerprint(plain),
		rotatedAt: time.Now().UTC(),
	}, nil
}

func (s *Server) rollbackToken(
	ctx context.Context, podID string, old serviceTokenMaterial, restart bool,
) error {
	var stopErr error
	if restart {
		stopErr = s.drv.Stop(ctx, podID)
	}
	dbErr := s.store.RotatePodServiceToken(podID, old.encrypted, old.fingerprint, old.rotatedAt)
	driverErr := s.drv.UpdateServiceToken(ctx, podID, tokenSecret(old.plain))
	startErr := s.restoreRunningState(ctx, podID, restart)
	return errors.Join(stopErr, dbErr, driverErr, startErr)
}

func (s *Server) restoreRunningState(ctx context.Context, podID string, running bool) error {
	if !running {
		return nil
	}
	return s.drv.Start(ctx, podID)
}

func tokenSecret(value string) driver.SecretFileSpec {
	return driver.SecretFileSpec{
		Name: "pod-service-token", ContainerPath: driver.PodServiceTokenPath,
		Value: value, Mode: 0o400, UID: driver.DefaultRuntimeUID, GID: driver.DefaultRuntimeGID,
	}
}
