package api

import (
	"fmt"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
)

type desiredPodRuntime struct {
	spec    driver.PodSpec
	runtime runtimeconfig.Result
}

func (s *Server) buildDesiredPodSpec(pod repo.Pod) (driver.PodSpec, error) {
	desired, err := s.buildDesiredPodRuntime(pod)
	return desired.spec, err
}

func (s *Server) buildDesiredPodRuntime(pod repo.Pod) (desiredPodRuntime, error) {
	builder, err := s.newRuntimeBuilder()
	if err != nil {
		return desiredPodRuntime{}, err
	}
	runtime, err := builder.Build(pod.PodID)
	if err != nil {
		return desiredPodRuntime{}, err
	}
	spec, err := s.assemblePodSpec(pod, runtime)
	if err != nil {
		return desiredPodRuntime{}, err
	}
	return desiredPodRuntime{spec: spec, runtime: runtime}, nil
}

func (s *Server) newRuntimeBuilder() (*runtimeconfig.Builder, error) {
	builder, err := runtimeconfig.New(s.store, s.cipher, runtimeconfig.Options{
		ConsoleInternalURL:    s.cfg.ConsoleInternalURL,
		StateDirectory:        s.cfg.RuntimeStateDir,
		PublicSkillsDirectory: s.cfg.RuntimePublicSkillsDir,
		MaxSkillConcurrency:   s.cfg.RuntimeDefaults.MaxSkillConcurrency,
		MaxBrowserConcurrency: s.cfg.RuntimeDefaults.MaxBrowserConcurrency,
	})
	return builder, err
}

func (s *Server) assemblePodSpec(pod repo.Pod, runtime runtimeconfig.Result) (driver.PodSpec, error) {
	channels, configs, err := s.decodeChannelSettings(pod)
	if err != nil {
		return driver.PodSpec{}, err
	}
	rawConfigs, err := rawChannelConfigs(configs)
	if err != nil {
		return driver.PodSpec{}, err
	}
	serviceToken, err := s.cipher.Decrypt(pod.ServiceTokenEnc)
	if err != nil {
		return driver.PodSpec{}, fmt.Errorf("decrypt Pod service token: %w", err)
	}
	global, _, err := s.readGlobalResources()
	if err != nil {
		return driver.PodSpec{}, err
	}
	spec := driver.PodSpec{
		PodID: pod.PodID, Channels: channels, ChannelConfigs: rawConfigs,
		ImageTag: pod.ImageTag, GatewayToken: crypto.DeriveGatewayToken(serviceToken),
		AutomationPlatformURL:   s.cfg.AutomationPlatformURL,
		AutomationPlatformToken: s.cfg.AutomationPlatformToken,
		MultiUser:               runtime.Config,
		Resource:                driver.ResolveResourceSpec(podResourceSpec(pod), global, s.resourceFallback()),
		ServiceToken:            tokenSecret(serviceToken),
	}
	if err := spec.Validate(); err != nil {
		return driver.PodSpec{}, err
	}
	return spec, nil
}
