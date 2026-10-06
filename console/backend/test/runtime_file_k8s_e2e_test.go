//go:build e2e && integration

package test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

func TestRuntimeFileK8sStartup_S03(t *testing.T) {
	h := newRuntimeFileE2E(t, "k8s")
	h.create(false)
	pod := h.waitConverged()
	h.assertFileStartup(pod.ConfigGeneration)
	secret, err := h.kube.CoreV1().Secrets(h.namespace).Get(h.ctx, driver.ContainerName(h.podID)+"-runtime-config", metav1.GetOptions{})
	if err != nil || len(secret.Data[driver.RuntimeConfigFileName]) == 0 {
		t.Fatal("real runtime Secret missing")
	}
	dep, err := h.kube.AppsV1().Deployments(h.namespace).Get(h.ctx, driver.ContainerName(h.podID), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, mount := range dep.Spec.Template.Spec.Containers[0].VolumeMounts {
		if mount.Name == "runtime-config" && (!mount.ReadOnly || mount.SubPath != "") {
			t.Fatal("real mount is not a directory projection")
		}
	}
}

func TestRuntimeFileK8sUpgrade_S06(t *testing.T) {
	h := newRuntimeFileE2E(t, "k8s")
	h.create(false)
	h.makeUsers(1)
	h.waitConverged()
	h.stateSentinel(true)
	volume := h.volumeIdentity()
	h.forceLegacy()
	h.waitConverged()
	before := h.snapshot()
	e2eData[e2ePod](t, h.request(http.MethodPost, "/containers/"+h.podID+"/upgrade", map[string]string{"imageTag": requireE2EEnv(t, "MUAD_E2E_FILE_IMAGE")}))
	pod := h.waitConverged()
	h.assertFileStartup(pod.ConfigGeneration)
	if h.volumeIdentity() != volume || !strings.Contains(h.stateSentinel(false), "retained-e2e-state") || h.snapshot().Environment["OPENCLAW_GATEWAY_TOKEN"] != before.Environment["OPENCLAW_GATEWAY_TOKEN"] {
		t.Fatal("migration lost state or rotated gateway credential")
	}
}

func TestRuntimeFileCreateUpgradeContract_S08(t *testing.T) {
	for _, kind := range []string{"k8s", "docker"} {
		t.Run(kind, func(t *testing.T) {
			h := newRuntimeFileE2E(t, kind)
			h.create(false)
			h.assertFileStartup(h.waitConverged().ConfigGeneration)
			e2eData[e2ePod](t, h.request(http.MethodPost, "/containers/"+h.podID+"/upgrade", map[string]string{"imageTag": requireE2EEnv(t, "MUAD_E2E_NEXT_FILE_IMAGE")}))
			h.assertFileStartup(h.waitConverged().ConfigGeneration)
		})
	}
}

func TestRuntimeFileUpgradeFailForward_E02(t *testing.T) {
	for _, kind := range []string{"k8s", "docker"} {
		for _, legacy := range []bool{false, true} {
			t.Run(kind+"/"+map[bool]string{false: "file", true: "env"}[legacy], func(t *testing.T) {
				h := newRuntimeFileE2E(t, kind)
				h.create(false)
				h.makeUsers(1)
				h.waitConverged()
				h.stateSentinel(true)
				if legacy {
					h.forceLegacy()
					h.waitConverged()
				}
				snapshot := h.snapshot()
				volume := h.volumeIdentity()
				target := requireE2EEnv(t, "MUAD_E2E_UNHEALTHY_IMAGE")
				result := h.request(http.MethodPost, "/containers/"+h.podID+"/upgrade", map[string]string{"imageTag": target})
				// 一次性升级失败停在 error：不自动回退，保留目标镜像与状态供人工修复。
				if result.Code != 50216 {
					t.Fatalf("fail-forward not reported: code %d", result.Code)
				}
				after := h.pod()
				if after.State != repo.PodStateError || after.ImageTag != target {
					t.Fatalf("pod must stop in error on the target image: %+v", after)
				}
				if h.volumeIdentity() != volume {
					t.Fatal("fail-forward must not restore or replace the state volume")
				}
				if h.snapshot().Mode != snapshot.Mode {
					t.Fatal("fail-forward must not restore startup input")
				}
			})
		}
	}
}

func TestRuntimeFileLargeDTO_B01(t *testing.T) {
	for _, kind := range []string{"k8s", "docker"} {
		t.Run(kind, func(t *testing.T) {
			h := newRuntimeFileE2E(t, kind)
			h.create(false)
			h.makeUsers(10)
			name := h.podID + "-traditional"
			h.uploadSkill("", name, "traditional-script-survives", 256, false)
			pod := h.waitConverged()
			snapshot := h.snapshot()
			if len(snapshot.RuntimeJSON) <= 128*1024 || len(snapshot.RuntimeJSON) >= 900*1024 {
				t.Fatalf("valid DTO boundary not established: %d bytes", len(snapshot.RuntimeJSON))
			}
			config, err := driver.DecodeRuntimeConfig(bytes.NewReader(snapshot.RuntimeJSON))
			if err != nil {
				t.Fatal("invalid large runtime DTO")
			}
			users := 0
			traditional := false
			for _, agent := range config.Agents {
				if agent.ID != "main" && !agent.Default {
					users++
				}
			}
			for _, policy := range config.Skills.Agents {
				for _, grant := range policy.Allowed {
					if grant.Name == name && grant.EntryType == "traditional-script" && len(grant.ScriptFiles) > 256 {
						traditional = true
					}
				}
			}
			if users != 10 || !traditional {
				t.Fatal("large fixture removed traditional script semantics")
			}
			h.restartAndWait()
			h.assertFileStartup(h.waitConverged().ConfigGeneration)
			if pod.ConfigGeneration != h.pod().ConfigGeneration {
				t.Fatal("restart changed desired generation")
			}
		})
	}
}

func TestRuntimeFileStartupSourceRecovery_E05(t *testing.T) {
	for _, kind := range []string{"k8s", "docker"} {
		t.Run(kind, func(t *testing.T) { assertRealSourceRecovery(t, kind) })
	}
}

func assertRealSourceRecovery(t *testing.T, kind string) {
	h := newRuntimeFileE2E(t, kind)
	h.create(false)
	h.makeUsers(1)
	before := h.waitConverged()
	h.concurrentPodUpdates(requireE2EEnv(t, "MUAD_E2E_NEXT_FILE_IMAGE"))
	after := h.waitConverged()
	if after.ConfigGeneration <= before.ConfigGeneration {
		t.Fatal("concurrent generation did not advance")
	}
	view := e2eData[struct{ DisplayName string }](t, h.request(http.MethodGet, "/containers/"+h.podID, nil))
	if view.DisplayName != "Concurrent config survives" {
		t.Fatal("upgrade overwrote concurrent configuration")
	}
	// K8s Secret projection is asynchronous. Read the actual worker path until
	// propagation catches up, then restart and verify the current source again.
	deadline := time.Now().Add(2 * time.Minute)
	for {
		out := h.worker(`import fs from 'node:fs';console.log(JSON.parse(fs.readFileSync(process.env.MUAD_RUNTIME_CONFIG_FILE,'utf8')).generation);`)
		if strings.TrimSpace(out) == jsonNumber(after.ConfigGeneration) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup projection did not converge")
		}
		time.Sleep(time.Second)
	}
	h.crashDuringApply()
	e2eData[json.RawMessage](t, h.request(http.MethodPost, "/containers/"+h.podID+"/apply-config", nil))
	h.waitConverged()
	e2eData[e2ePod](t, h.request(http.MethodPost, "/containers/"+h.podID+"/upgrade", map[string]string{"imageTag": requireE2EEnv(t, "MUAD_E2E_NEXT_FILE_IMAGE")}))
	h.restartAndWait()
	h.assertFileStartup(h.waitConverged().ConfigGeneration)
}

func (h *runtimeFileE2E) crashDuringApply() {
	if len(h.users) == 0 {
		h.t.Fatal("crash recovery requires an owned user fixture")
	}
	e2eData[json.RawMessage](h.t, h.request(http.MethodPatch, "/human-users/"+h.users[0].HumanUserID, map[string]string{"prompt": "Recover current Console configuration after abrupt process death."}))
	deadline := time.Now().Add(2 * time.Minute)
	for h.pod().LastApplyStatus != "applying" {
		if time.Now().After(deadline) {
			h.t.Fatal("apply crash window was not exercised")
		}
		time.Sleep(500 * time.Millisecond)
	}
	name := requireE2EEnv(h.t, "MUAD_E2E_"+strings.ToUpper(h.kind)+"_CONSOLE_NAME")
	if !strings.HasPrefix(name, "muad-e2e-") {
		h.t.Fatal("crash test requires an isolated Console")
	}
	if h.kind == "docker" {
		h.command("docker", "kill", "--signal", "KILL", name)
		h.command("docker", "start", name)
	} else {
		dep, err := h.kube.AppsV1().Deployments(h.namespace).Get(h.ctx, name, metav1.GetOptions{})
		if err != nil {
			h.t.Fatal(err)
		}
		pods, err := h.kube.CoreV1().Pods(h.namespace).List(h.ctx, metav1.ListOptions{LabelSelector: labels.SelectorFromSet(dep.Spec.Selector.MatchLabels).String()})
		if err != nil {
			h.t.Fatal(err)
		}
		if len(pods.Items) != 1 {
			h.t.Fatal("isolated Console must have one process for crash test")
		}
		zero := int64(0)
		if err := h.kube.CoreV1().Pods(h.namespace).Delete(h.ctx, pods.Items[0].Name, metav1.DeleteOptions{GracePeriodSeconds: &zero}); err != nil {
			h.t.Fatal(err)
		}
	}
	h.waitConsole()
}

func jsonNumber(n int64) string { return strconv.FormatInt(n, 10) }

func (h *runtimeFileE2E) restartConsole() {
	name := requireE2EEnv(h.t, "MUAD_E2E_"+strings.ToUpper(h.kind)+"_CONSOLE_NAME")
	if !strings.HasPrefix(name, "muad-e2e-") {
		h.t.Fatal("Console restart requires isolated muad-e2e-* name")
	}
	if h.kind == "docker" {
		h.command("docker", "restart", name)
	} else {
		h.command("kubectl", "-n", h.namespace, "rollout", "restart", "deployment/"+name)
		h.command("kubectl", "-n", h.namespace, "rollout", "status", "deployment/"+name, "--timeout=120s")
	}
	h.waitConsole()
}

func (h *runtimeFileE2E) waitConsole() {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		result, err := h.requestBody(http.MethodGet, "/containers/"+h.podID, "application/json", nil)
		if err == nil && result.Code == 0 {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatal("isolated Console did not recover its existing SQLite record")
		}
		time.Sleep(time.Second)
	}
}

func (h *runtimeFileE2E) concurrentPodUpdates(image string) {
	type mutation struct {
		method, path string
		body         map[string]string
	}
	updates := []mutation{
		{http.MethodPatch, "/containers/" + h.podID, map[string]string{"displayName": "Concurrent config survives"}},
		{http.MethodPost, "/containers/" + h.podID + "/upgrade", map[string]string{"imageTag": image}},
	}
	type result struct {
		envelope e2eEnvelope
		err      error
	}
	results := make(chan result, len(updates))
	for _, update := range updates {
		raw, err := json.Marshal(update.body)
		if err != nil {
			h.t.Fatal(err)
		}
		go func(update mutation, raw []byte) {
			envelope, err := h.requestBody(update.method, update.path, "application/json", bytes.NewReader(raw))
			results <- result{envelope, err}
		}(update, raw)
	}
	for range updates {
		current := <-results
		if current.err != nil || current.envelope.Code != 0 {
			h.t.Fatal("concurrent real API mutation failed")
		}
	}
}
