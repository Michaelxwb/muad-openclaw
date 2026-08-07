package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const maxJSONBodyBytes = 1 << 20

func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any) error {
	return decodeJSONBodyLimit(w, r, destination, maxJSONBodyBytes)
}

// decodeJSONBodyLimit is decodeJSONBody with an explicit body cap, for
// endpoints that must accept larger payloads than the default JSON limit
// (e.g. the private-skill ingest endpoint, which carries a base64 bundle).
func decodeJSONBodyLimit(w http.ResponseWriter, r *http.Request, destination any, maxBytes int64) error {
	reader := http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request body contains trailing JSON")
		}
		return err
	}
	return nil
}
