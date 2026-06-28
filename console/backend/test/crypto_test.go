package test

import (
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

func TestMask(t *testing.T) {
	if crypto.Mask("abc") != "***" {
		t.Error("short value should fully mask")
	}
	if crypto.Mask("abcdefgh") != "abcd****" {
		t.Errorf("Mask = %q", crypto.Mask("abcdefgh"))
	}
}
