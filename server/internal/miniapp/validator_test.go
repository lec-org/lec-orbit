package miniapp

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func makeTestZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("write zip entry %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func TestValidateZipBundleSuccessAndSingleRootStrip(t *testing.T) {
	manifest := `{"schemaVersion":1,"id":"lec-snake","name":"乐程贪吃蛇","version":"1.0.0","type":"minigame","engine":"cocos","entry":"index.html"}`
	data := makeTestZip(t, map[string]string{
		"dist/orbit.manifest.json": manifest,
		"dist/index.html":          "<html><body>ok</body></html>",
	})

	res, err := ValidateZipBundle(data)
	if err != nil {
		t.Fatalf("expected valid zip, got error: %v", err)
	}
	if res.Manifest.ID != "lec-snake" || res.Manifest.Engine != "cocos" {
		t.Fatalf("unexpected manifest: %+v", res.Manifest)
	}
	if len(res.SHA256) != 64 {
		t.Fatalf("expected 64-char sha256, got %q", res.SHA256)
	}
}

func TestValidateZipBundleRejectsZipSlipAndMissingEntry(t *testing.T) {
	manifest := `{"schemaVersion":1,"id":"lec-snake","name":"乐程贪吃蛇","version":"1.0.0","type":"minigame","engine":"unity","entry":"index.html"}`
	evil := makeTestZip(t, map[string]string{
		"orbit.manifest.json": manifest,
		"index.html":          "ok",
		"../escape.txt":       "bad",
	})
	if _, err := ValidateZipBundle(evil); err == nil || !strings.Contains(err.Error(), "路径穿越") {
		t.Fatalf("expected path traversal rejection, got: %v", err)
	}

	missingEntry := makeTestZip(t, map[string]string{
		"orbit.manifest.json": manifest,
	})
	if _, err := ValidateZipBundle(missingEntry); err == nil || !strings.Contains(err.Error(), "入口文件") {
		t.Fatalf("expected missing entry rejection, got: %v", err)
	}
}

func TestIsAllowedGitHubReleaseURL(t *testing.T) {
	if !IsAllowedGitHubReleaseURL("https://github.com/lec-org/demo/releases/download/v1.0.0/game.zip") {
		t.Fatal("expected github.com release url allowed")
	}
	if !IsAllowedGitHubReleaseURL("https://objects.githubusercontent.com/github-production-release-asset/123") {
		t.Fatal("expected objects.githubusercontent.com allowed")
	}
	if IsAllowedGitHubReleaseURL("http://github.com/lec-org/demo.zip") {
		t.Fatal("expected non-https url rejected")
	}
	if IsAllowedGitHubReleaseURL("https://evil.example.com/game.zip") {
		t.Fatal("expected non-github host rejected")
	}
}
