package test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
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

func TestBindingCodeAPI_PendingUserCreatesFirstIdentityCode(t *testing.T) {
	e, user := createPendingHumanUser(t)
	path := "/api/v1/human-users/" + user.HumanUserID + "/binding-codes"
	rr := e.do(http.MethodPost, path, `{"channel":"wecom","expiresInMinutes":30}`)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[bindingCodeCreateResponse](t, rr.Body.Bytes())
	if created.BindingCode.Purpose != "create_user_first_identity" {
		t.Fatalf("pending-user binding purpose = %q", created.BindingCode.Purpose)
	}
}

func TestInternalBinding_InvalidUserStateReturnsConflict(t *testing.T) {
	e, user := createPendingHumanUser(t)
	codec, err := crypto.NewBindingCodeCodec("mk")
	if err != nil {
		t.Fatalf("create binding codec: %v", err)
	}
	record, plain, err := e.store.CreateBindingCode(codec, repo.BindingCodeRequest{
		HumanUserID:     user.HumanUserID,
		PodID:           user.PodID,
		Channel:         "wecom",
		OpenClawChannel: "wecom",
		AccountID:       "default",
		Purpose:         repo.BindingPurposeAddIdentity,
	})
	if err != nil {
		t.Fatalf("create add-identity binding code: %v", err)
	}
	rr := doInternalBind(e, e.drv.created["pod-a"].ServiceToken.Value, bindingBody(plain, "default", "sender", "direct"))
	assertStatus(t, rr, http.StatusConflict)
	if strings.Contains(rr.Body.String(), "activate binding code") {
		t.Fatalf("invalid state leaked as internal error: %s", rr.Body.String())
	}
	stored, err := e.store.GetBindingCode(record.BindingCodeID)
	if err != nil || stored.Status != repo.BindingCodeStatusPending {
		t.Fatalf("invalid-state activation mutated binding code: %+v, %v", stored, err)
	}
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
