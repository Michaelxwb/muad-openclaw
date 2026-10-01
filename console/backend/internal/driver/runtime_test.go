package driver

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
)

func TestRuntimeFileTask004_S11(t *testing.T) {
	raw, err := os.ReadFile("../../../../bin/test/fixtures/runtime-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	config, err := DecodeRuntimeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	spec := testPodSpec(config.PodID, "worker:new")
	spec.MultiUser = config
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		t.Fatal(err)
	}
	if payload.Environment["MUAD_RUNTIME_CONFIG_FILE"] != RuntimeConfigFilePath {
		t.Fatalf("file env = %+v", payload.Environment)
	}
	if _, exists := payload.Environment["MUAD_RUNTIME_CONFIG"]; exists {
		t.Fatal("DTO retained in file-mode env")
	}
	decoded, err := DecodeRuntimeConfig(bytes.NewReader(payload.RuntimeJSON))
	if err != nil {
		t.Fatalf("DTO roundtrip: %v", err)
	}
	encodedConfig, err := json.Marshal(decoded)
	if err != nil || !bytes.Equal(encodedConfig, payload.RuntimeJSON) {
		t.Fatalf("DTO JSON roundtrip: %v", err)
	}
	assertStartupSnapshotRoundtrip(t, payload)
	assertStartupPayloadErrors(t, spec)
}

func assertStartupSnapshotRoundtrip(t *testing.T, payload RuntimeStartupPayload) {
	t.Helper()
	for _, mode := range []RuntimeStartupMode{RuntimeStartupEnv, RuntimeStartupFile} {
		snapshot := RuntimeStartupSnapshot{Mode: mode, RuntimeJSON: payload.RuntimeJSON, Environment: payload.Environment}
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		var restored RuntimeStartupSnapshot
		if err := json.Unmarshal(encoded, &restored); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(restored, snapshot) {
			t.Fatal("ambiguous recovery material")
		}
	}
}

func assertStartupPayloadErrors(t *testing.T, spec PodSpec) {
	t.Helper()
	spec.ChannelConfigs = map[string]json.RawMessage{"wecom": json.RawMessage("{")}
	if _, err := BuildRuntimeStartupPayload(spec); err == nil {
		t.Fatal("invalid channel JSON silently ignored")
	}
	spec.ChannelConfigs = nil
	spec.MultiUser.Generation = 0
	if _, err := BuildRuntimeStartupPayload(spec); !errors.Is(err, ErrInvalidRuntimeConfig) {
		t.Fatalf("invalid DTO error = %v", err)
	}
}

func TestValidLocale(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "zh", want: true},
		{value: "en", want: true},
		{value: "fr", want: false},
		{value: "ZH", want: false},
		{value: "zh-CN", want: false},
		{value: " ", want: false},
	} {
		if got := validLocale(tc.value); got != tc.want {
			t.Errorf("validLocale(%q) = %v, want %v", tc.value, got, tc.want)
		}
	}
}
