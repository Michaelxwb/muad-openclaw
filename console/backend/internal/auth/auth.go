// Package auth provides admin password hashing and stateless HMAC session
// tokens (no external JWT dependency).
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// ErrInvalidToken is returned when a session token fails verification.
var ErrInvalidToken = errors.New("auth: invalid token")

// HashPassword returns a bcrypt hash for storage.
func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

// CheckPassword reports whether pw matches the stored bcrypt hash.
func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

type claims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
}

// Sign issues an HMAC-SHA256 token "payload.sig" for subject with the given TTL.
func Sign(secret, subject string, ttl time.Duration) string {
	raw, _ := json.Marshal(claims{Sub: subject, Exp: time.Now().Add(ttl).Unix()})
	p := base64.RawURLEncoding.EncodeToString(raw)
	return p + "." + mac(secret, p)
}

// Verify checks signature and expiry, returning the subject on success.
func Verify(secret, token string) (string, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", ErrInvalidToken
	}
	if !hmac.Equal([]byte(parts[1]), []byte(mac(secret, parts[0]))) {
		return "", ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", ErrInvalidToken
	}
	var c claims
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", ErrInvalidToken
	}
	if time.Now().Unix() > c.Exp {
		return "", ErrInvalidToken
	}
	return c.Sub, nil
}

func mac(secret, msg string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
