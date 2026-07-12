package test

import (
	"net/http"
	"strings"
	"testing"
)

type bindingCodeAPIView struct {
	BindingCodeID string `json:"bindingCodeId"`
	CodeHint      string `json:"codeHint"`
	Status        string `json:"status"`
	Purpose       string `json:"purpose"`
}

type bindingCodeCreateResponse struct {
	BindingCode bindingCodeAPIView `json:"bindingCode"`
	Code        string             `json:"code"`
}

func TestBindingCodeAPI_PlaintextIsReturnedOnceAndCanBeRevoked(t *testing.T) {
	e, user := createDirectHumanUser(t)
	path := "/api/v1/human-users/" + user.HumanUserID + "/binding-codes"
	rr := e.do(http.MethodPost, path, `{"channel":"wecom","expiresInMinutes":30}`)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[bindingCodeCreateResponse](t, rr.Body.Bytes())
	if !strings.HasPrefix(created.Code, "MUAD-") || created.BindingCode.BindingCodeID == "" ||
		created.BindingCode.Purpose != "add_identity_to_existing_user" {
		t.Fatalf("unexpected binding code: %+v", created)
	}
	rr = e.do(http.MethodGet, path, "")
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), created.Code) || strings.Contains(strings.ToLower(rr.Body.String()), "codehash") {
		t.Fatalf("binding list exposed code material: %s", rr.Body.String())
	}
	revokePath := path + "/" + created.BindingCode.BindingCodeID
	rr = e.do(http.MethodDelete, revokePath, "")
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"status":"revoked"`) {
		t.Fatalf("revoke response = %s", rr.Body.String())
	}
	assertStatus(t, e.do(http.MethodDelete, revokePath, ""), http.StatusConflict)
}

func TestBindingCodeAPI_ValidatesChannelAndPathOwnership(t *testing.T) {
	e, user := createDirectHumanUser(t)
	path := "/api/v1/human-users/" + user.HumanUserID + "/binding-codes"
	rr := e.do(http.MethodPost, path, `{"channel":"feishu"}`)
	assertStatus(t, rr, http.StatusBadRequest)
	rr = e.do(http.MethodPost, path, `{"channel":"wecom","accountId":"bad account"}`)
	assertStatus(t, rr, http.StatusBadRequest)
	rr = e.do(http.MethodPost, path, `{"channel":"wecom"}`)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[bindingCodeCreateResponse](t, rr.Body.Bytes())
	wrongPath := "/api/v1/human-users/wrong-user/binding-codes/" + created.BindingCode.BindingCodeID
	assertStatus(t, e.do(http.MethodDelete, wrongPath, ""), http.StatusNotFound)
}
