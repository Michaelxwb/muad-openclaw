// Package crypto encrypts sensitive fields (WeCom secret, LLM api_key) at rest
// with AES-256-GCM. The 32-byte key is derived from CONSOLE_MASTER_KEY via
// SHA-256 (NFR-SEC-02 / RULE-04); the master key itself never touches the DB.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strings"
)

const serviceTokenBytes = 32

// Cipher encrypts and decrypts short secrets.
type Cipher struct {
	aead cipher.AEAD
}

// New derives an AES-256-GCM cipher from the master key string.
func New(masterKey string) (*Cipher, error) {
	if masterKey == "" {
		return nil, errors.New("crypto: empty master key")
	}
	sum := sha256.Sum256([]byte(masterKey))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

// Encrypt returns base64(nonce || ciphertext) for the given plaintext.
func (c *Cipher) Encrypt(plaintext string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt.
func (c *Cipher) Decrypt(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	ns := c.aead.NonceSize()
	if len(raw) < ns {
		return "", errors.New("crypto: ciphertext too short")
	}
	nonce, ct := raw[:ns], raw[ns:]
	plain, err := c.aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// GenerateServiceToken returns a cryptographically random Pod service token.
func GenerateServiceToken() (string, error) {
	raw := make([]byte, serviceTokenBytes)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// DeriveGatewayToken creates a separate one-way Gateway credential from the
// Pod service token so the internal API token never enters the normal env.
func DeriveGatewayToken(serviceToken string) string {
	mac := hmac.New(sha256.New, []byte(serviceToken))
	_, _ = mac.Write([]byte("muad-openclaw-gateway-v1"))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Fingerprint returns a full SHA-256 fingerprint suitable for indexed lookup.
func Fingerprint(value string) string {
	sum := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ConstantTimeEqual compares secrets without leaking the matching prefix.
func ConstantTimeEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// DisplayFingerprint returns an abbreviated fingerprint for administrator APIs.
func DisplayFingerprint(fingerprint string) string {
	const visible = 8
	prefix := ""
	value := fingerprint
	if strings.HasPrefix(value, "sha256:") {
		prefix = "sha256:"
		value = strings.TrimPrefix(value, prefix)
	}
	if len(value) <= visible*2 {
		return fingerprint
	}
	return prefix + value[:visible] + "..." + value[len(value)-visible:]
}
