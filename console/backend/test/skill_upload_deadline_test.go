package test

import (
	"net/http/httptest"
	"time"
)

// In-memory handler tests have no socket; expose the deadline capability
// provided by net/http in production. Socket behavior is tested in package api.
type skillDeadlineRecorder struct {
	*httptest.ResponseRecorder
}

func (r *skillDeadlineRecorder) SetReadDeadline(time.Time) error { return nil }
