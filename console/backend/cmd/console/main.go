// Command console is the muad admin/monitoring control plane.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/api"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/collector"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	store, err := repo.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer store.Close()

	cipher, err := crypto.New(cfg.MasterKey)
	if err != nil {
		log.Fatalf("crypto: %v", err)
	}

	drv, err := driver.New(cfg.RuntimeDriver, cfg.MuadNet, cfg.SkillsDir, driver.K8sOptions{
		Namespace:    cfg.K8sNamespace,
		SkillsPVC:    cfg.K8sSkillsPVC,
		StorageClass: cfg.K8sStorageClass,
		StateSize:    cfg.K8sStateSize,
	})
	if err != nil {
		log.Fatalf("driver: %v", err)
	}

	if err := api.BootstrapAdmin(store, cfg.AdminUser, cfg.AdminPassword); err != nil {
		log.Fatalf("bootstrap admin: %v", err)
	}

	cache := monitor.NewCache()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Background monitoring collector (TASK-011).
	go collector.New(drv, cache, time.Duration(cfg.CollectIntervalSec)*time.Second).Run(ctx)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           api.NewServer(cfg, store, cipher, drv, cache).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[console] listening on %s (driver=%s)", cfg.ListenAddr, cfg.RuntimeDriver)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	<-ctx.Done()

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("[console] graceful shutdown failed: %v", err)
		os.Exit(1)
	}
	log.Print("[console] stopped")
}
