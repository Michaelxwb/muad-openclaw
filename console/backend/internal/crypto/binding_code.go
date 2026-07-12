package crypto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	bindingCodePrefix   = "MUAD-"
	bindingCodeLength   = 8
	bindingCodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	bindingCodeDomain   = "muad-binding-code-v1"
)

var ErrInvalidBindingCodeFormat = errors.New("crypto: invalid binding code format")

// BindingCodeCodec generates and hashes short-lived activation codes.
type BindingCodeCodec struct {
	hmacKey [sha256.Size]byte
}

// NewBindingCodeCodec derives an isolated HMAC key from the Console master key.
func NewBindingCodeCodec(masterKey string) (*BindingCodeCodec, error) {
	if masterKey == "" {
		return nil, errors.New("crypto: empty binding-code master key")
	}
	mac := hmac.New(sha256.New, []byte(masterKey))
	_, _ = mac.Write([]byte(bindingCodeDomain))
	var key [sha256.Size]byte
	copy(key[:], mac.Sum(nil))
	return &BindingCodeCodec{hmacKey: key}, nil
}

// Generate returns MUAD- plus eight unambiguous Crockford-style characters.
func (c *BindingCodeCodec) Generate() (string, error) {
	if c == nil {
		return "", errors.New("crypto: nil binding-code codec")
	}
	raw := make([]byte, bindingCodeLength)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", fmt.Errorf("generate binding code: %w", err)
	}
	encoded := make([]byte, bindingCodeLength)
	for index, value := range raw {
		encoded[index] = bindingCodeAlphabet[int(value)&31]
	}
	return bindingCodePrefix + string(encoded), nil
}

// Hash normalizes a user-supplied code and returns its keyed lookup hash.
func (c *BindingCodeCodec) Hash(code string) (string, error) {
	if c == nil {
		return "", errors.New("crypto: nil binding-code codec")
	}
	normalized, err := NormalizeBindingCode(code)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, c.hmacKey[:])
	_, _ = mac.Write([]byte(normalized))
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil)), nil
}

// NormalizeBindingCode accepts case-insensitive input with optional spaces.
func NormalizeBindingCode(code string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	normalized = strings.ReplaceAll(normalized, " ", "")
	if len(normalized) != len(bindingCodePrefix)+bindingCodeLength ||
		!strings.HasPrefix(normalized, bindingCodePrefix) {
		return "", ErrInvalidBindingCodeFormat
	}
	for _, char := range normalized[len(bindingCodePrefix):] {
		if !strings.ContainsRune(bindingCodeAlphabet, char) {
			return "", ErrInvalidBindingCodeFormat
		}
	}
	return normalized, nil
}

// BindingCodeHint returns a non-sensitive suffix for administrator lists.
func BindingCodeHint(code string) (string, error) {
	normalized, err := NormalizeBindingCode(code)
	if err != nil {
		return "", err
	}
	return "****" + normalized[len(normalized)-4:], nil
}
