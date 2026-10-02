package api

import (
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

const skillUploadReadTimeout = 2 * time.Minute

func setSkillUploadReadDeadline(w http.ResponseWriter, r *http.Request) bool {
	deadline := time.Now().Add(skillUploadReadTimeout)
	if err := http.NewResponseController(w).SetReadDeadline(deadline); err != nil {
		writeErrDetail(w, r, errcode.InternalSkillUploadDeadline, err.Error())
		return false
	}
	return true
}

func isSkillUploadTimeout(err error) bool {
	var timeout net.Error
	return errors.As(err, &timeout) && timeout.Timeout()
}
