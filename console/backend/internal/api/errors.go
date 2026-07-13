package api

import (
	"errors"
	"net/http"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	codeInvalidRequest          = 40001
	codeInvalidField            = 40002
	codeInvalidBinding          = 40003
	codeAdminUnauthorized       = 40101
	codePodUnauthorized         = 40102
	codeNotFound                = 40401
	codeCredentialNotConfigured = 40402
	codeConflict                = 40901
	codePodCapacity             = 40902
	codeIdentityConflict        = 40903
	codeGenerationConflict      = 40904
	codePlatformDisabled        = 40905
	codeRetainedState           = 40906
	codePodStateConflict        = 40907
	codeRateLimited             = 42901
	codeInternal                = 50001
	codeRuntimeFailure          = 50201
	codeDependencyUnavailable   = 50301
)

func writeRepoError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repo.ErrNotFound):
		writeErr(w, http.StatusNotFound, codeNotFound, "resource not found")
	case errors.Is(err, repo.ErrPodExists), errors.Is(err, repo.ErrHumanUserExists):
		writeErr(w, http.StatusConflict, codeConflict, "resource already exists")
	case errors.Is(err, repo.ErrPlatformExists):
		writeErr(w, http.StatusConflict, codeConflict, "platform already exists")
	case errors.Is(err, repo.ErrPodCapacity):
		writeErr(w, http.StatusConflict, codePodCapacity, "Pod Human User capacity exceeded")
	case errors.Is(err, repo.ErrGenerationConflict):
		writeErr(w, http.StatusConflict, codeGenerationConflict, "configuration generation conflict")
	case errors.Is(err, repo.ErrInvalidStateTransition):
		writeErr(w, http.StatusConflict, codePodStateConflict, "resource state does not allow this operation")
	case errors.Is(err, repo.ErrLLMModelAlreadyBound):
		writeErr(w, http.StatusConflict, codeConflict, "LLM model is already bound")
	case errors.Is(err, repo.ErrBindingCodeUsed), errors.Is(err, repo.ErrBindingCodeRevoked),
		errors.Is(err, repo.ErrBindingCodeExpired), errors.Is(err, repo.ErrBindingCodeScope):
		writeErr(w, http.StatusConflict, codeInvalidBinding, "binding code is not usable")
	case errors.Is(err, repo.ErrInvalidHumanUser), errors.Is(err, repo.ErrInvalidCapacity),
		errors.Is(err, repo.ErrInvalidBindingCode), errors.Is(err, repo.ErrInvalidPlatform),
		errors.Is(err, repo.ErrInvalidLLMModel):
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid field value")
	case errors.Is(err, repo.ErrCredentialNotConfigured):
		writeErr(w, http.StatusNotFound, codeCredentialNotConfigured, "platform credential not configured")
	case errors.Is(err, repo.ErrPlatformDisabled):
		writeErr(w, http.StatusConflict, codePlatformDisabled, "platform is disabled")
	case errors.Is(err, repo.ErrIdentityExists):
		writeErr(w, http.StatusConflict, codeIdentityConflict, "scoped identity already exists")
	default:
		writeErr(w, http.StatusInternalServerError, codeInternal, "internal error")
	}
}
