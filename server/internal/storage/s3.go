package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/lec-org/lec-orbit/server/internal/config"
)

// S3Uploader 零外部 SDK 依赖的 AWS SigV4 兼容上传器，直连校园统一 RustFS。
type S3Uploader struct {
	cfg        config.Config
	httpClient *http.Client
}

func NewS3Uploader(cfg config.Config) *S3Uploader {
	if cfg.S3Endpoint == "" || cfg.S3AccessKey == "" || cfg.S3SecretKey == "" {
		return nil
	}
	return &S3Uploader{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 25 * time.Second},
	}
}

func (u *S3Uploader) PutPublicObject(ctx context.Context, relKey string, data []byte, contentType string) (string, error) {
	cleanRel := strings.TrimLeft(relKey, "/")
	fullKey := cleanRel
	if u.cfg.S3KeyPrefix != "" && !strings.HasPrefix(cleanRel, u.cfg.S3KeyPrefix+"/") {
		fullKey = u.cfg.S3KeyPrefix + "/" + cleanRel
	}

	parsed, err := url.Parse(u.cfg.S3Endpoint)
	if err != nil {
		return "", err
	}
	canonicalURI := "/" + encodePath(path.Join(u.cfg.S3Bucket, fullKey))
	targetURL := fmt.Sprintf("%s://%s%s", parsed.Scheme, parsed.Host, canonicalURI)

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := sha256Hex(data)

	canonicalHeaders := fmt.Sprintf("content-type:%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n",
		contentType, parsed.Host, payloadHash, amzDate)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{
		http.MethodPut,
		canonicalURI,
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, u.cfg.S3Region)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	signingKey := deriveSigningKey(u.cfg.S3SecretKey, dateStamp, u.cfg.S3Region, "s3")
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))
	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		u.cfg.S3AccessKey, credentialScope, signedHeaders, signature)

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, targetURL, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("Authorization", authHeader)

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("上传 RustFS 失败（HTTP %d）: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return u.cfg.S3PublicBaseURL + "/" + cleanRel, nil
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

func deriveSigningKey(secret, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), dateStamp)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	return hmacSHA256(kService, "aws4_request")
}

func encodePath(p string) string {
	parts := strings.Split(strings.TrimLeft(p, "/"), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}
