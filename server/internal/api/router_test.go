package api

import (
	"strings"
	"testing"

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
