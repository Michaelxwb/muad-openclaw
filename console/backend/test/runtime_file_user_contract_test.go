//go:build e2e && integration

package test

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestRuntimeFileUserDetailContract_S22(t *testing.T) {
	e, user := createDirectHumanUser(t)
	path := "/api/v1/human-users/" + user.HumanUserID
	before, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatal(err)
	}
	get := e.do(http.MethodGet, path, "")
	var envelope e2eEnvelope
	if err := json.Unmarshal(get.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	decoded := e2eHumanUser(t, envelope)
	if decoded.HumanUserID != user.HumanUserID || decoded.AgentID != user.AgentID || decoded.PodID != "pod-a" {
		t.Fatal("E2E helper lost wrapped user ownership")
	}
	body, err := json.Marshal(e2eUserPromptUpdate{Prompt: "actual prompt update"})
	if err != nil {
		t.Fatal(err)
	}
	patch := e.do(http.MethodPatch, path, string(body))
	if patch.Code != http.StatusOK {
		t.Fatalf("prompt patch failed HTTP %d", patch.Code)
	}
	if err := json.Unmarshal(patch.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	updated := e2eHumanUser(t, envelope)
	stored, err := e.store.GetHumanUser(user.HumanUserID)
	if err != nil {
		t.Fatal(err)
	}
	after, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Prompt != "actual prompt update" || after.ConfigGeneration <= before.ConfigGeneration || updated.ModelConfigID != decoded.ModelConfigID {
		t.Fatal("E2E request did not change prompt/generation or preserved model binding")
	}
}
