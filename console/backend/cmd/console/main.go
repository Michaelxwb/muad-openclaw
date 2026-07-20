// Command console is the muad admin/monitoring control plane.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/api"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/collector"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	consolelog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/logging"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeapply"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/usercleanup"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("console: %v", err)
	}
}

type dependencies struct {
	cfg    *config.Config
	store  *repo.Store
	cipher *crypto.Cipher
	driver driver.RuntimeDriver
}

func run() error {
	deps, err := loadDependencies()
	if err != nil {
		return err
	}
	defer deps.store.Close()
	logCloser, err := consolelog.Configure(consolelog.Options{Directory: deps.cfg.LogDir})
	if err != nil {
		return fmt.Errorf("logging: %w", err)
	}
	defer logCloser.Close()
	if deps.cfg.LogDir != "" {
		log.Printf("[console] daily file logging enabled directory=%s", deps.cfg.LogDir)
	}
	cache := monitor.NewCache()
	coordinator, err := newRuntimeCoordinator(deps.cfg, deps.store, deps.cipher, deps.driver)
	if err != nil {
		return fmt.Errorf("runtime coordinator: %w", err)
	}
	cleaner, err := usercleanup.New(deps.store, deps.driver, coordinator, 0)
	if err != nil {
		return fmt.Errorf("Human User cleaner: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startBackground(ctx, deps, cache, coordinator, cleaner)
	srv := newHTTPServer(deps, cache, coordinator)
	serveErr := serve(srv, deps.cfg)
	select {
	case <-ctx.Done():
		if err := shutdown(srv); err != nil {
			return err
		}
		log.Print("[console] stopped")
		return nil
	case err := <-serveErr:
		return err
	}
}

func loadDependencies() (*dependencies, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	store, err := repo.Open(cfg.DBPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	cipher, err := crypto.New(cfg.MasterKey)
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("crypto: %w", err)
	}
	runtimeOptions := driver.RuntimeOptions{
		Timezone:        cfg.RuntimeTimezone,
		StateDir:        cfg.RuntimeStateDir,
		PublicSkillsDir: cfg.RuntimePublicSkillsDir,
	}
	drv, err := driver.New(cfg.RuntimeDriver, cfg.MuadNet, cfg.SkillsDir, driver.K8sOptions{
		Namespace:          cfg.K8sNamespace,
		SkillsPVC:          cfg.K8sSkillsPVC,
		SkillsStorageClass: cfg.K8sSkillsStorageClass,
		SkillsSize:         cfg.K8sSkillsSize,
		StorageClass:       cfg.K8sStorageClass,
		StateSize:          cfg.K8sStateSize,
	}, runtimeOptions)
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("driver: %w", err)
	}
	if err := api.BootstrapAdmin(store, cfg.AdminUser, cfg.AdminPassword); err != nil {
		store.Close()
		return nil, fmt.Errorf("bootstrap admin: %w", err)
	}
	return &dependencies{cfg: cfg, store: store, cipher: cipher, driver: drv}, nil
}

func startBackground(
	ctx context.Context, deps *dependencies, cache *monitor.Cache,
	coordinator *runtimeapply.Coordinator, cleaner *usercleanup.Cleaner,
) {
	monitorDefaults := driver.ResourceSpec{
		MemLimit:              deps.cfg.RuntimeDefaults.MemLimit,
		CPULimit:              deps.cfg.RuntimeDefaults.CPULimit,
		RestartPolicy:         deps.cfg.RuntimeDefaults.RestartPolicy,
		MaxSkillConcurrency:   deps.cfg.RuntimeDefaults.MaxSkillConcurrency,
		MaxBrowserConcurrency: deps.cfg.RuntimeDefaults.MaxBrowserConcurrency,
	}
	go collector.New(deps.driver, deps.store, cache, monitorDefaults,
		time.Duration(deps.cfg.CollectIntervalSec)*time.Second).Run(ctx)
	go coordinator.Run(ctx)
	go cleaner.Run(ctx)
}

func newHTTPServer(
	deps *dependencies, cache *monitor.Cache, coordinator *runtimeapply.Coordinator,
) *http.Server {
	return &http.Server{
		Addr: deps.cfg.ListenAddr,
		Handler: api.NewServer(
			deps.cfg, deps.store, deps.cipher, deps.driver, cache, coordinator,
		).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      3 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}
}

func serve(srv *http.Server, cfg *config.Config) <-chan error {
	result := make(chan error, 1)
	go func() {
		log.Printf("[console] listening on %s (driver=%s)", cfg.ListenAddr, cfg.RuntimeDriver)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			result <- fmt.Errorf("serve: %w", err)
		}
	}()
	return result
}

func shutdown(srv *http.Server) error {
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}

func newRuntimeCoordinator(
	cfg *config.Config, store *repo.Store, cipher *crypto.Cipher, drv driver.RuntimeDriver,
) (*runtimeapply.Coordinator, error) {
	builder, err := runtimeconfig.New(store, cipher, runtimeconfig.Options{
		ConsoleInternalURL:    cfg.ConsoleInternalURL,
		MaxSkillConcurrency:   cfg.RuntimeDefaults.MaxSkillConcurrency,
		MaxBrowserConcurrency: cfg.RuntimeDefaults.MaxBrowserConcurrency,
	})
	if err != nil {
		return nil, err
	}
	applier, err := runtimeapply.New(drv, runtimeapply.Options{})
	if err != nil {
		return nil, err
	}
	return runtimeapply.NewCoordinator(store, builder, applier, runtimeapply.CoordinatorOptions{})
}
