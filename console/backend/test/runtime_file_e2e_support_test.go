//go:build e2e && integration

package test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type runtimeFileE2E struct {
	t                                  *testing.T
	ctx                                context.Context
	kind, url, token, podID, namespace string
	client                             *http.Client
	drv                                driver.RuntimeDriver
	kube                               kubernetes.Interface
	users                              []e2eUser
	modelIDs                           []string
}
type e2eEnvelope struct {
	Code int
	Data json.RawMessage
}
type e2ePod struct {
	PodID, ImageTag, State, LastApplyStatus string
	ConfigGeneration, AppliedGeneration     int64
}
type e2eUser struct {
	HumanUserID, AgentID, ModelConfigID, PodID string
	ExternalID                                 string `json:"-"`
}
type e2eUserPromptUpdate struct {
	Prompt string `json:"prompt"`
}

func e2eHumanUser(t *testing.T, result e2eEnvelope) e2eUser {
	t.Helper()
	user := e2eData[struct {
		HumanUser e2eUser `json:"humanUser"`
	}](t, result).HumanUser
	if user.HumanUserID == "" {
		t.Fatal("invalid E2E Human User detail envelope")
	}
	return user
}

type e2eChannels struct {
	Channels       []string                   `json:"channels"`
	ChannelConfigs map[string]json.RawMessage `json:"channelConfigs"`
}

func requireE2EEnv(t *testing.T, key string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		t.Fatalf("missing isolated E2E setting %s (scenario is not verified)", key)
	}
	return value
}

// The two URLs point to dedicated Consoles running the candidate code. All
// mutations go through their real API/SQLite/Builder/Coordinator, never fakes.
func newRuntimeFileE2E(t *testing.T, kind string) *runtimeFileE2E {
	t.Helper()
	prefix := "MUAD_E2E_" + strings.ToUpper(kind) + "_"
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	t.Cleanup(cancel)
	h := &runtimeFileE2E{t: t, ctx: ctx, kind: kind, url: strings.TrimRight(requireE2EEnv(t, prefix+"CONSOLE_URL"), "/"), token: requireE2EEnv(t, prefix+"ADMIN_TOKEN"), client: &http.Client{Timeout: 5 * time.Minute}}
	h.podID = fmt.Sprintf("e2e-runtime-%x", time.Now().UnixNano())
	if kind == "k8s" {
		h.initK8s()
	} else {
		h.drv = driver.NewDockerDriver(requireE2EEnv(t, prefix+"NETWORK"), "", driver.RuntimeOptions{})
	}
	t.Cleanup(func() { h.cleanupPod() })
	return h
}

func (h *runtimeFileE2E) initK8s() {
	h.namespace = requireE2EEnv(h.t, "MUAD_E2E_K8S_NAMESPACE")
	if !strings.HasPrefix(h.namespace, "muad-e2e-") {
		h.t.Fatal("Kubernetes E2E requires a dedicated muad-e2e-* namespace")
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{}).ClientConfig()
	}
	if err != nil {
		h.t.Fatal("E2E kubeconfig unavailable")
	}
	h.kube, err = kubernetes.NewForConfig(cfg)
	if err != nil {
		h.t.Fatal(err)
	}
	h.drv, err = driver.NewK8sDriver(driver.K8sOptions{Namespace: h.namespace})
	if err != nil {
		h.t.Fatal(err)
	}
}

func (h *runtimeFileE2E) request(method, path string, body any) e2eEnvelope {
	h.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		h.t.Fatal(err)
	}
	result, err := h.requestBody(method, path, "application/json", bytes.NewReader(raw))
	if err != nil {
		h.t.Fatalf("E2E API %s %s failed: %s", method, path, auditlog.RedactDiagnostic(err.Error()))
	}
	return result
}

func (h *runtimeFileE2E) requestBody(method, path, contentType string, body io.Reader) (result e2eEnvelope, resultErr error) {
	req, err := http.NewRequestWithContext(h.ctx, method, h.url+"/api/v1"+path, body)
	if err != nil {
		return e2eEnvelope{}, err
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("Content-Type", contentType)
	response, err := h.client.Do(req)
	if err != nil {
		return e2eEnvelope{}, err
	}
	defer func() { resultErr = errors.Join(resultErr, response.Body.Close()) }()
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&result); err != nil {
		return result, fmt.Errorf("invalid API envelope (HTTP %d)", response.StatusCode)
	}
	return result, nil
}

func e2eData[T any](t *testing.T, result e2eEnvelope) T {
	t.Helper()
	if result.Code != 0 {
		t.Fatalf("real Console API code=%d", result.Code)
	}
	var value T
	if err := json.Unmarshal(result.Data, &value); err != nil {
		t.Fatal("invalid E2E data contract")
	}
	return value
}

func (h *runtimeFileE2E) create(adopt bool) e2ePod {
	var channels e2eChannels
	if err := json.Unmarshal([]byte(requireE2EEnv(h.t, "MUAD_E2E_CHANNELS_JSON")), &channels); err != nil {
		h.t.Fatal("invalid channel fixture JSON")
	}
	return e2eData[e2ePod](h.t, h.request(http.MethodPost, "/containers", struct {
		PodID        string `json:"podId"`
		ImageTag     string `json:"imageTag"`
		MaxUsers     int    `json:"maxUsers"`
		AdoptState   bool   `json:"adoptState"`
		RestoreUsers bool   `json:"restoreUsers"`
		e2eChannels
	}{h.podID, requireE2EEnv(h.t, "MUAD_E2E_FILE_IMAGE"), 10, adopt, true, channels}))
}

func (h *runtimeFileE2E) pod() e2ePod {
	return e2eData[e2ePod](h.t, h.request(http.MethodGet, "/containers/"+h.podID, nil))
}

func (h *runtimeFileE2E) waitConverged() e2ePod {
	h.t.Helper()
	deadline := time.NewTimer(4 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		pod := h.pod()
		if pod.AppliedGeneration == pod.ConfigGeneration && pod.AppliedGeneration > 0 && pod.LastApplyStatus == "applied" {
			status := gateway.Probe(h.ctx, h.drv, h.podID)
			if status.Healthy && status.RuntimeGuardHealthy && status.RuntimeGeneration == pod.ConfigGeneration {
				return pod
			}
		}
		select {
		case <-deadline.C:
			h.t.Fatal("real Worker/Console generation failed to converge")
			return pod
		case <-h.ctx.Done():
			h.t.Fatal("E2E context expired")
			return pod
		case <-ticker.C:
		}
	}
}

func (h *runtimeFileE2E) snapshot() driver.RuntimeStartupSnapshot {
	h.t.Helper()
	source, ok := h.drv.(driver.RuntimeStartupDriver)
	if !ok {
		h.t.Fatal("missing real startup source")
	}
	snapshot, err := source.SnapshotStartupConfig(h.ctx, h.podID)
	if err != nil {
		h.t.Fatalf("source snapshot failed: %s", auditlog.RedactDiagnostic(err.Error()))
	}
	return snapshot
}

func (h *runtimeFileE2E) worker(program string, args ...string) string {
	h.t.Helper()
	command := append([]string{"node", "--input-type=module", "-e", program}, args...)
	out, err := h.drv.Exec(h.ctx, h.podID, command...)
	if err != nil {
		h.t.Fatalf("real Worker execution failed: %s", auditlog.RedactDiagnostic(err.Error()))
	}
	return out
}

func (h *runtimeFileE2E) assertFileStartup(generation int64) {
	h.t.Helper()
	out := h.worker(`import fs from 'node:fs';const p=process.env.MUAD_RUNTIME_CONFIG_FILE;const c=JSON.parse(fs.readFileSync(p,'utf8'));const s=fs.statSync(p);console.log(JSON.stringify({uid:process.getuid(),generation:c.generation,mode:s.mode&511,dtoEnv:Object.hasOwn(process.env,'MUAD_RUNTIME_CONFIG'),file:p}));`)
	var observed struct {
		UID        int
		Generation int64
		Mode       int
		DTOEnv     bool
		File       string
	}
	if err := json.Unmarshal([]byte(out), &observed); err != nil {
		h.t.Fatal("invalid startup probe")
	}
	if observed.UID != 1000 || observed.Generation != generation || observed.DTOEnv || observed.File != driver.RuntimeConfigFilePath || observed.Mode&0o007 != 0 {
		h.t.Fatal("non-root file input contract violated")
	}
	if h.snapshot().Mode != driver.RuntimeStartupFile {
		h.t.Fatal("driver reported non-file workload")
	}
}

func (h *runtimeFileE2E) stateSentinel(write bool) string {
	return h.worker(`import fs from 'node:fs';import path from 'node:path';const root=process.env.OPENCLAW_STATE_DIR;const files=['workspace-a00/e2e-memory.txt','agents/a00/sessions/e2e-session.txt'];if(process.argv[1]==='write'){for(const f of files){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),'retained-e2e-state',{mode:384});}}console.log(files.map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('|'));`, fmt.Sprint(map[bool]string{true: "write", false: "read"}[write]))
}

func (h *runtimeFileE2E) volumeIdentity() string {
	if h.kind == "k8s" {
		pvc, err := h.kube.CoreV1().PersistentVolumeClaims(h.namespace).Get(h.ctx, driver.ContainerName(h.podID)+"-state", metav1.GetOptions{})
		if err != nil {
			h.t.Fatal(err)
		}
		return string(pvc.UID)
	}
	out := h.command("docker", "volume", "inspect", driver.ContainerName(h.podID)+"-state", "--format", "{{.Name}}:{{.CreatedAt}}")
	return strings.TrimSpace(out)
}

func (h *runtimeFileE2E) command(name string, args ...string) string {
	h.t.Helper()
	cmd := exec.CommandContext(h.ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.t.Fatalf("E2E command %s failed: %s", name, auditlog.RedactDiagnostic(string(out)))
	}
	return string(out)
}

func (h *runtimeFileE2E) restoreSpec(snapshot driver.RuntimeStartupSnapshot, image string) driver.PodSpec {
	config, err := driver.DecodeRuntimeConfig(bytes.NewReader(snapshot.RuntimeJSON))
	if err != nil {
		h.t.Fatal("invalid real startup DTO")
	}
	token := strings.TrimSpace(h.worker(`import fs from 'node:fs';process.stdout.write(fs.readFileSync('/run/secrets/muad/pod-service-token','utf8'));`))
	return driver.PodSpec{PodID: h.podID, ImageTag: image, MultiUser: config, Channels: config.Channels.Enabled, ChannelConfigs: config.Channels.Configs, GatewayToken: snapshot.Environment["OPENCLAW_GATEWAY_TOKEN"], ServiceToken: driver.SecretFileSpec{ContainerPath: driver.PodServiceTokenPath, Value: token, Mode: 0o400, UID: 1000, GID: 1000}, AdoptState: true}
}

func (h *runtimeFileE2E) forceLegacy() {
	snapshot := h.snapshot()
	snapshot.Mode = driver.RuntimeStartupEnv
	spec := h.restoreSpec(snapshot, requireE2EEnv(h.t, "MUAD_E2E_LEGACY_IMAGE"))
	// Seed an existing legacy record through the real repo, rather than add an
	// old-image creation capability to the candidate Console's ordinary API.
	path := requireE2EEnv(h.t, "MUAD_E2E_"+strings.ToUpper(h.kind)+"_DB")
	if _, err := os.Stat(path); err != nil {
		h.t.Fatal("isolated Console database mount missing")
	}
	store, err := repo.Open(path)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			h.t.Error(err)
		}
	}()
	pod, err := store.GetPod(h.podID)
	if err != nil {
		h.t.Fatal("fixture database does not belong to this Console")
	}
	update := podUpdateFrom(pod, pod.MaxUsers)
	update.ImageTag = spec.ImageTag
	if err := store.UpdatePod(h.podID, update); err != nil {
		h.t.Fatal(err)
	}
	pod, err = store.GetPod(h.podID)
	if err != nil {
		h.t.Fatal(err)
	}
	spec.MultiUser.Generation = pod.ConfigGeneration
	source := h.drv.(driver.RuntimeStartupDriver)
	if err := source.RestoreRuntime(h.ctx, spec, snapshot); err != nil {
		h.t.Fatalf("legacy fixture failed: %s", auditlog.RedactDiagnostic(err.Error()))
	}
	if h.snapshot().Mode != driver.RuntimeStartupEnv {
		h.t.Fatal("legacy fixture does not use env")
	}
}

func (h *runtimeFileE2E) makeUsers(count int) []e2eUser {
	models := make([]map[string]string, count)
	for i := range models {
		models[i] = map[string]string{"displayName": fmt.Sprintf("%s-%d", h.podID, i), "provider": requireE2EEnv(h.t, "MUAD_E2E_MODEL_PROVIDER"), "baseUrl": requireE2EEnv(h.t, "MUAD_E2E_MODEL_URL"), "apiKey": requireE2EEnv(h.t, "MUAD_E2E_MODEL_KEY"), "model": requireE2EEnv(h.t, "MUAD_E2E_MODEL_NAME")}
	}
	created := e2eData[struct {
		Items []struct{ ModelConfigID string }
	}](h.t, h.request(http.MethodPost, "/llm/models/batch", map[string]any{"models": models}))
	if len(created.Items) != count {
		h.t.Fatal("fixture model count mismatch")
	}
	users := make([]e2eUser, count)
	var recipients []string
	if raw := os.Getenv("MUAD_E2E_DELIVERY_USER_IDS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &recipients); err != nil {
			h.t.Fatal("invalid dedicated delivery fixture IDs")
		}
	}
	for _, model := range created.Items {
		h.modelIDs = append(h.modelIDs, model.ModelConfigID)
	}
	for i := range users {
		externalID := fmt.Sprintf("%s-%d", h.podID, i)
		if i < len(recipients) {
			externalID = recipients[i]
		}
		result := h.request(http.MethodPost, "/containers/"+h.podID+"/human-users", map[string]any{"displayName": fmt.Sprintf("User %d", i), "agentId": fmt.Sprintf("a%02d", i), "modelConfigId": created.Items[i].ModelConfigID, "identity": map[string]string{"channel": "wecom", "externalId": externalID, "externalIdType": "corp_userid"}})
		users[i] = e2eData[struct{ HumanUser e2eUser }](h.t, result).HumanUser
		users[i].ExternalID = externalID
		h.users = append(h.users, users[i])
	}
	return users
}

func (h *runtimeFileE2E) uploadSkill(userID, name, marker string, files int, longTask bool) string {
	bundle := map[string][]byte{name + "/SKILL.md": []byte("---\nname: " + name + "\ndescription: Execute the script and report its result.\n---\nRun node scripts/run.mjs.\n")}
	bundle[name+"/scripts/run.mjs"] = []byte("console.log(" + fmt.Sprintf("%q", marker) + ");\n")
	for i := 0; i < files; i++ {
		bundle[fmt.Sprintf("%s/scripts/%03d-%s.mjs", name, i, strings.Repeat("f", 90))] = []byte("export const fixture = true;\n")
	}
	if longTask {
		bundle[name+"/muad.skill.json"] = []byte(`{"name":"` + name + `","version":"1.0.0","runtime":"script","entrypoint":"scripts/run.mjs","longTask":true}`)
	}
	result := h.postSkillBundle(userID, name, makeZipWithFiles(h.t, bundle))
	asset := e2eData[struct{ Skill struct{ SkillID string } }](h.t, result)
	return asset.Skill.SkillID
}

func (h *runtimeFileE2E) postSkillBundle(userID, name string, bundle []byte) e2eEnvelope {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("expectedName", name); err != nil {
		h.t.Fatal(err)
	}
	file, err := writer.CreateFormFile("bundle", name+".zip")
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := file.Write(bundle); err != nil {
		h.t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		h.t.Fatal(err)
	}
	path := "/skills/public"
	if userID != "" {
		path = "/human-users/" + userID + "/skills/private"
	}
	result, err := h.requestBody(http.MethodPost, path, writer.FormDataContentType(), &body)
	if err != nil {
		h.t.Fatal("real Skill upload failed")
	}
	return result
}

func (h *runtimeFileE2E) cleanupPod() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := h.drv.Remove(ctx, h.podID, false); err != nil {
		h.t.Errorf("E2E runtime cleanup: %s", auditlog.RedactDiagnostic(err.Error()))
	}
	// The API detaches users and expires credentials; no production IDs are used.
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, h.url+"/api/v1/containers/"+h.podID+"?deleteState=true", nil)
	if err != nil {
		h.t.Error(err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	response, err := h.client.Do(req)
	if err != nil {
		h.t.Errorf("E2E record cleanup failed")
		return
	}
	if err := response.Body.Close(); err != nil {
		h.t.Error(err)
	}
	for _, user := range h.users {
		h.cleanupRecord(ctx, "/human-users/"+user.HumanUserID)
	}
	for _, id := range h.modelIDs {
		h.cleanupRecord(ctx, "/llm/models/"+id)
	}
}

func (h *runtimeFileE2E) cleanupRecord(ctx context.Context, path string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, h.url+"/api/v1"+path, nil)
	if err != nil {
		h.t.Error("fixture cleanup request invalid")
		return
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	response, err := h.client.Do(req)
	if err != nil {
		h.t.Error("fixture cleanup API unavailable")
		return
	}
	if response.StatusCode >= 400 && response.StatusCode != 404 {
		h.t.Errorf("fixture cleanup HTTP %d", response.StatusCode)
	}
	if err := response.Body.Close(); err != nil {
		h.t.Error(err)
	}
}

func runtimeDigest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
