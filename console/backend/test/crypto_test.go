package test

import (
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	c, err := crypto.New("master-secret")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	plain := "ThgnuUozE8mvxMaBVlwnDjCdu1gcmy3SQUjGJDSoE8U"

	enc, err := c.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if enc == plain {
		t.Fatal("ciphertext equals plaintext")
	}
	got, err := c.Decrypt(enc)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if got != plain {
		t.Errorf("round trip mismatch: got %q", got)
	}
}

func TestServiceToken_GenerationFingerprintAndComparison(t *testing.T) {
	first, err := crypto.GenerateServiceToken()
	if err != nil {
		t.Fatalf("GenerateServiceToken: %v", err)
	}
	second, err := crypto.GenerateServiceToken()
	if err != nil {
		t.Fatalf("GenerateServiceToken second: %v", err)
	}
	if first == second || len(first) < 40 {
		t.Fatalf("generated tokens are not sufficiently distinct: %q / %q", first, second)
	}
	fingerprint := crypto.Fingerprint(first)
	if !strings.HasPrefix(fingerprint, "sha256:") || len(fingerprint) != len("sha256:")+64 {
		t.Fatalf("unexpected fingerprint %q", fingerprint)
	}
	if !crypto.ConstantTimeEqual(first, first) {
		t.Fatal("equal tokens did not match")
	}
	if crypto.ConstantTimeEqual(first, second) {
		t.Fatal("different tokens matched")
	}
	display := crypto.DisplayFingerprint(fingerprint)
	if display == fingerprint || !strings.HasPrefix(display, "sha256:") || !strings.Contains(display, "...") {
		t.Fatalf("unexpected display fingerprint %q", display)
	}
}

func TestDeriveGatewayToken_IsStableAndDistinct(t *testing.T) {
	serviceToken := "pod-service-token"
	first := crypto.DeriveGatewayToken(serviceToken)
	second := crypto.DeriveGatewayToken(serviceToken)
	if first == serviceToken || first == "" || first != second {
		t.Fatalf("derived gateway token is invalid: %q / %q", first, second)
	}
	if first == crypto.DeriveGatewayToken("another-service-token") {
		t.Fatal("different service tokens derived the same Gateway token")
	}
}

func TestBindingCodeCodec_GenerateNormalizeAndHash(t *testing.T) {
	codec, err := crypto.NewBindingCodeCodec("master-key")
	if err != nil {
		t.Fatalf("NewBindingCodeCodec: %v", err)
	}
	code, err := codec.Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(code) != 13 || !strings.HasPrefix(code, "MUAD-") {
		t.Fatalf("unexpected code format %q", code)
	}
	hash, err := codec.Hash(strings.ToLower(code))
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if !strings.HasPrefix(hash, "hmac-sha256:") || strings.Contains(hash, code) {
		t.Fatalf("unexpected binding-code hash %q", hash)
	}
	hint, err := crypto.BindingCodeHint(code)
	if err != nil || len(hint) != 8 || !strings.HasPrefix(hint, "****") {
		t.Fatalf("BindingCodeHint = %q, %v", hint, err)
	}
	if _, err := codec.Hash("MUAD-INVALID!"); err == nil {
		t.Fatal("expected invalid alphabet to be rejected")
	}
	if normalized, err := crypto.NormalizeBindingCode("muad-x1gd 78w5"); err != nil || normalized != "MUAD-X1GD78W5" {
		t.Fatalf("shared alphabet code was rejected: %q, %v", normalized, err)
	}
}

func TestEncrypt_NonDeterministic(t *testing.T) {
	c, _ := crypto.New("k")
	a, _ := c.Encrypt("same")
	b, _ := c.Encrypt("same")
	if a == b {
		t.Error("expected distinct ciphertexts (random nonce)")
	}
}

func TestDecrypt_WrongKeyFails(t *testing.T) {
	c1, _ := crypto.New("key-1")
	c2, _ := crypto.New("key-2")
	enc, _ := c1.Encrypt("secret")
	if _, err := c2.Decrypt(enc); err == nil {
		t.Error("expected decrypt failure with wrong key")
	}
}

func TestNew_EmptyKey(t *testing.T) {
	if _, err := crypto.New(""); err == nil {
		t.Error("expected error for empty master key")
	}
}
