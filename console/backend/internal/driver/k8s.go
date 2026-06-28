package driver

import "context"

// K8sDriver is a placeholder for the cluster runtime. The interface is fixed now
// so the rest of the console is agnostic; the real client-go implementation is
// deferred to P1 (RISK-05). Every method returns ErrNotImplemented.
type K8sDriver struct{}

// NewK8sDriver returns the k8s stub driver.
func NewK8sDriver() *K8sDriver { return &K8sDriver{} }

func (*K8sDriver) Create(context.Context, UserSpec, string) error  { return ErrNotImplemented }
func (*K8sDriver) Start(context.Context, string) error             { return ErrNotImplemented }
func (*K8sDriver) Stop(context.Context, string) error              { return ErrNotImplemented }
func (*K8sDriver) Restart(context.Context, string) error           { return ErrNotImplemented }
func (*K8sDriver) Remove(context.Context, string, bool) error      { return ErrNotImplemented }
func (*K8sDriver) List(context.Context) ([]ContainerInfo, error)   { return nil, ErrNotImplemented }
func (*K8sDriver) Stats(context.Context, string) (Stats, error)    { return Stats{}, ErrNotImplemented }
func (*K8sDriver) StatsAll(context.Context) (map[string]Stats, error) { return nil, ErrNotImplemented }
func (*K8sDriver) Logs(context.Context, string, int) (string, error) { return "", ErrNotImplemented }
func (*K8sDriver) Exec(context.Context, string, ...string) (string, error) { return "", ErrNotImplemented }
func (*K8sDriver) Reap(context.Context, string) error              { return ErrNotImplemented }
func (*K8sDriver) Revive(context.Context, string) error            { return ErrNotImplemented }
