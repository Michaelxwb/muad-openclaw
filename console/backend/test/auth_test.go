package test

import (
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/auth"
)

func TestPasswordHashAndCheck(t *testing.T) {
	h, err := auth.HashPassword("s3cret")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !auth.CheckPassword(h, "s3cret") {
		t.Error("correct password rejected")
	}
	if auth.CheckPassword(h, "wrong") {
		t.Error("wrong password accepted")
	}
}

func TestTokenSignVerify(t *testing.T) {
	tok := auth.Sign("k", "root", time.Hour)
	sub, err := auth.Verify("k", tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if sub != "root" {
		t.Errorf("subject = %q, want root", sub)
	}
}

func TestTokenWrongSecret(t *testing.T) {
	tok := auth.Sign("k1", "root", time.Hour)
	if _, err := auth.Verify("k2", tok); err == nil {
		t.Error("expected failure with wrong secret")
	}
}

func TestTokenExpired(t *testing.T) {
	tok := auth.Sign("k", "root", -time.Minute)
	if _, err := auth.Verify("k", tok); err == nil {
		t.Error("expected expiry failure")
	}
}

func TestTokenMalformed(t *testing.T) {
	if _, err := auth.Verify("k", "garbage"); err == nil {
		t.Error("expected malformed failure")
	}
}
