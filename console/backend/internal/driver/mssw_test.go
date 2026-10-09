package driver

import "testing"

func TestMSSWChannelContract(t *testing.T) {
	if !IsValidChannel("mssw") || OpenClawChannelFor("mssw") != "mssw" {
		t.Fatal("MSSW channel missing")
	}
	plugins := PluginsAllowForChannels([]string{"mssw", "mssw"})
	if len(plugins) != 1 || plugins[0] != "mssw-channel" {
		t.Fatal("MSSW plugin mapping invalid")
	}
}

func TestConsoleSecretDirectoryCanUsePersistentHostPath(t *testing.T) {
	path := t.TempDir()
	t.Setenv("CONSOLE_DOCKER_SECRET_DIR", path)
	driver := NewDockerDriver("network", "", RuntimeOptions{})
	if driver.secretDir != path {
		t.Fatal("persistent secret directory was ignored")
	}
}

func TestDockerDesktopRuntimeMountAlias(t *testing.T) {
	if !sameDockerHostPath("/host_mnt/Users/max/runtime", "/Users/max/runtime") {
		t.Fatal("Desktop alias rejected")
	}
	if sameDockerHostPath("/host_mnt/Users/other/runtime", "/Users/max/runtime") {
		t.Fatal("foreign mount accepted")
	}
}
