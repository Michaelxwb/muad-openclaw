package api

import (
	"errors"
	"net/http"
)

type inputValidationError struct {
	code     int
	detailZH string
	detailEN string
	wrapped  error
}

func newInputValidationError(code int, detailZH, detailEN string) error {
	return &inputValidationError{code: code, detailZH: detailZH, detailEN: detailEN}
}

func wrapInputValidationError(code int, cause error, detailZH, detailEN string) error {
	return &inputValidationError{code: code, detailZH: detailZH, detailEN: detailEN, wrapped: cause}
}

func (err *inputValidationError) Error() string {
	if err.detailEN != "" {
		return err.detailEN
	}
	return err.detailZH
}

func (err *inputValidationError) Unwrap() error {
	return err.wrapped
}

func writeInputValidationError(w http.ResponseWriter, r *http.Request, fallbackCode int, err error) {
	writeErrDetail(w, r, inputValidationCode(fallbackCode, err), inputValidationDetail(r, err))
}

func inputValidationCode(fallbackCode int, err error) int {
	var validationErr *inputValidationError
	if errors.As(err, &validationErr) && validationErr.code != 0 {
		return validationErr.code
	}
	return fallbackCode
}

func inputValidationDetail(r *http.Request, err error) string {
	var validationErr *inputValidationError
	if errors.As(err, &validationErr) {
		if langFrom(r.Context()) == langEN && validationErr.detailEN != "" {
			return validationErr.detailEN
		}
		return validationErr.detailZH
	}
	if err == nil {
		return ""
	}
	return err.Error()
}
