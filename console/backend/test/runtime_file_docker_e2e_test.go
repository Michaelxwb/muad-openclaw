//go:build e2e && integration

package test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRuntimeFileDockerStartup_S04(t *testing.T) {
	h := newRuntimeFileE2E(t, "docker")
	h.create(false)
	users := h.makeUsers(1)
	pod := h.waitConverged()
	h.assertFileStartup(pod.ConfigGeneration)
	probe := make(chan struct {
		out string
		err error
	}, 1)
	go func() {
		out, err := h.drv.Exec(h.ctx, h.podID, "node", "--input-type=module", "-e", dockerOpenInodeProbe)
		probe <- struct {
			out string
			err error
		}{out, err}
	}()
	h.waitWorkerMarker("e2e-open-ready")
	e2eHumanUser(t, h.request(http.MethodPatch, "/human-users/"+users[0].HumanUserID, e2eUserPromptUpdate{Prompt: "Read the updated startup source."}))
	pod = h.waitConverged()
	select {
	case result := <-probe:
		var observed struct {
			OldIntact, Readonly bool
			Generation          int64
		}
		if result.err != nil || json.Unmarshal([]byte(result.out), &observed) != nil || !observed.OldIntact || !observed.Readonly || observed.Generation != pod.ConfigGeneration {
			t.Fatal("real Docker bind failed atomic update/readonly contract")
		}
	case <-h.ctx.Done():
		t.Fatal("Docker inode probe timed out")
	}
	h.restartAndWait()
	h.assertFileStartup(pod.ConfigGeneration)
}

const dockerOpenInodeProbe = `import fs from 'node:fs';import path from 'node:path';
const file=process.env.MUAD_RUNTIME_CONFIG_FILE,fd=fs.openSync(file,'r'),old=fs.readFileSync(file),generation=JSON.parse(old).generation;
fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR,'e2e-open-ready'),'ready',{mode:384});
const deadline=Date.now()+180000;while(Date.now()<deadline){const current=JSON.parse(fs.readFileSync(file,'utf8'));if(current.generation>generation){const buffer=Buffer.alloc(old.length);fs.readSync(fd,buffer,0,buffer.length,0);let readonly=false;try{fs.writeFileSync(file,'must-not-write');}catch(e){if(e.code!=='EROFS')throw e;readonly=true;}fs.closeSync(fd);console.log(JSON.stringify({oldIntact:buffer.equals(old),readonly,generation:current.generation}));process.exit(0);}await new Promise(r=>setTimeout(r,200));}throw new Error('atomic update timed out');`

func (h *runtimeFileE2E) waitWorkerMarker(name string) {
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if strings.TrimSpace(h.worker(`import fs from 'node:fs';import path from 'node:path';console.log(fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR,process.argv[1])));`, name)) == "true" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	h.t.Fatal("Worker fixture marker timed out")
}

func (h *runtimeFileE2E) workloadIdentity() string {
	if h.kind == "docker" {
		return strings.TrimSpace(h.command("docker", "inspect", driver.ContainerName(h.podID), "--format", "{{.State.StartedAt}}"))
	}
	pods, err := h.kube.CoreV1().Pods(h.namespace).List(h.ctx, metav1.ListOptions{LabelSelector: "muad-pod=" + h.podID})
	if err != nil {
		h.t.Fatal("cannot inspect physical Worker identity")
	}
	for _, pod := range pods.Items {
		if pod.DeletionTimestamp == nil && pod.Status.Phase == "Running" {
			for _, status := range pod.Status.ContainerStatuses {
				if status.Ready {
					return string(pod.UID)
				}
			}
		}
	}
	return ""
}

func (h *runtimeFileE2E) restartAndWait() {
	old := h.workloadIdentity()
	if old == "" {
		h.t.Fatal("Worker identity unavailable before restart")
	}
	if err := h.drv.Restart(h.ctx, h.podID); err != nil {
		h.t.Fatal("real Worker restart failed")
	}
	deadline := time.Now().Add(4 * time.Minute)
	for time.Now().Before(deadline) {
		if current := h.workloadIdentity(); current != "" && current != old {
			h.waitConverged()
			return
		}
		time.Sleep(time.Second)
	}
	h.t.Fatal("physical Worker restart failed to become ready")
}
