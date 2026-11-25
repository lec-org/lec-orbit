package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/config"
)

func TestSanitizeHTMLStripsXSSAndKeepsFormatting(t *testing.T) {
	srv := NewServer(config.Load(), nil, nil, nil, nil, nil, nil)
	raw := `<h2>本周例会通知</h2><p>请查阅 <a href="https://doc.lecspace.top">文档</a></p><img src="https://drive.lecspace.top/orbit/a.png" onerror="alert(1)"><script>alert(2)</script>`
	safe, plain := srv.SanitizeHTML(raw)
	if strings.Contains(safe, "<script") || strings.Contains(safe, "onerror") {
		t.Fatalf("expected XSS stripped, got: %s", safe)
	}
	if !strings.Contains(safe, "<h2>本周例会通知</h2>") || !strings.Contains(safe, "https://drive.lecspace.top/orbit/a.png") {
		t.Fatalf("expected safe formatting and image preserved, got: %s", safe)
	}
	if !strings.Contains(plain, "本周例会通知") {
		t.Fatalf("expected plain text extracted, got: %s", plain)
	}
}

func TestCaptainRoleDetection(t *testing.T) {
	if !auth.IsCaptainRole([]string{"lec-studio:captain"}) {
		t.Fatal("expected lec-studio:captain to be recognized as captain")
	}
	if auth.IsCaptainRole([]string{"lec-studio:member", "lec-studio:senior-captain"}) {
		t.Fatal("expected member / senior-captain not to match captain")
	}
}

func TestVerifyWagerHMACSignature(t *testing.T) {
	secret := "test-wager-secret"
	now := time.UnixMilli(1795584000000)
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	body := []byte(`{"matchId":"8429","winnerUserId":"u1","result":"win"}`)

	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(ts))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !VerifyWagerHMACSignature(secret, ts, body, sig, now) {
		t.Fatal("expected valid HMAC signature to verify")
	}
	if VerifyWagerHMACSignature(secret, ts, []byte(`{"tampered":true}`), sig, now) {
		t.Fatal("expected tampered body to fail verification")
	}
	if VerifyWagerHMACSignature("wrong-secret", ts, body, sig, now) {
		t.Fatal("expected wrong secret to fail verification")
	}
	if VerifyWagerHMACSignature(secret, ts, body, sig, now.Add(10*time.Minute)) {
		t.Fatal("expected expired timestamp to fail verification")
	}
}
