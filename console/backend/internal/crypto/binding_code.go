package crypto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	bindingCodeDomain = "muad-binding-code-v1"
)

var ErrInvalidBindingCodeFormat = errors.New("crypto: invalid binding code format")

//go:embed binding_code_spec.json
var bindingCodeSpecJSON []byte

var bindingCodeSpec = mustLoadBindingCodeSpec(bindingCodeSpecJSON)

type bindingCodeSpecData struct {
	Prefix   string `json:"prefix"`
	Length   int    `json:"length"`
	Alphabet string `json:"alphabet"`
}

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
	raw := make([]byte, bindingCodeSpec.Length)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", fmt.Errorf("generate binding code: %w", err)
	}
	encoded := make([]byte, bindingCodeSpec.Length)
	for index, value := range raw {
		encoded[index] = bindingCodeSpec.Alphabet[int(value)&31]
	}
	return bindingCodeSpec.Prefix + string(encoded), nil
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
	if len(normalized) != len(bindingCodeSpec.Prefix)+bindingCodeSpec.Length ||
		!strings.HasPrefix(normalized, bindingCodeSpec.Prefix) {
		return "", ErrInvalidBindingCodeFormat
	}
	for _, char := range normalized[len(bindingCodeSpec.Prefix):] {
		if !strings.ContainsRune(bindingCodeSpec.Alphabet, char) {
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

func mustLoadBindingCodeSpec(data []byte) bindingCodeSpecData {
	var spec bindingCodeSpecData
	if err := json.Unmarshal(data, &spec); err != nil {
		panic(fmt.Sprintf("invalid binding_code_spec.json: %v", err))
	}
	if spec.Prefix == "" || spec.Length <= 0 || len(spec.Alphabet) != 32 {
		panic("invalid binding_code_spec.json: prefix, length and 32-character alphabet are required")
	}
	return spec
}
