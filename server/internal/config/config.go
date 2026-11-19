package config

import (
	"os"
	"strings"
)

// Config 保存 Orbit Go 后端运行时配置，全部由环境变量注入。
type Config struct {
	Port string

	DatabaseURL string
	RedisURL    string

	SSOEendpoint     string
	SSOIssuer        string
	SSOOrgID         string
	SSOM2MClientID   string
	SSOM2MClientSec  string
	SSOM2MResource   string
	OrbitAPIResource string

	InternalServiceToken string

	LecDocInternalURL   string
	LecDocInternalToken string
	LecDocPublicURL     string

	S3Endpoint      string
	S3Bucket        string
	S3Region        string
	S3AccessKey     string
	S3SecretKey     string
	S3PublicBaseURL string
	S3KeyPrefix     string
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func Load() Config {
	ssoEndpoint := strings.TrimRight(envOr("LEC_SSO_ENDPOINT", "https://sso.lecspace.top"), "/")
	ssoIssuer := strings.TrimRight(envOr("LEC_SSO_ISSUER", ssoEndpoint+"/oidc"), "/")
	return Config{
		Port:                 envOr("PORT", "8080"),
		DatabaseURL:          strings.TrimSpace(os.Getenv("DATABASE_URL")),
		RedisURL:             strings.TrimSpace(os.Getenv("REDIS_URL")),
		SSOEendpoint:         ssoEndpoint,
		SSOIssuer:            ssoIssuer,
		SSOOrgID:             envOr("LEC_SSO_ORG_ID", "lec-studio"),
		SSOM2MClientID:       strings.TrimSpace(os.Getenv("LEC_SSO_M2M_CLIENT_ID")),
		SSOM2MClientSec:      strings.TrimSpace(os.Getenv("LEC_SSO_M2M_CLIENT_SECRET")),
		SSOM2MResource:       envOr("LEC_SSO_M2M_RESOURCE", "https://default.logto.app/api"),
		OrbitAPIResource:     strings.TrimSpace(os.Getenv("LEC_ORBIT_API_RESOURCE")),
		InternalServiceToken: strings.TrimSpace(os.Getenv("ORBIT_INTERNAL_TOKEN")),
		LecDocInternalURL:    strings.TrimRight(envOr("LEC_DOC_INTERNAL_URL", "http://lec-doc.lec-doc-production.svc.cluster.local:3000"), "/"),
		LecDocInternalToken:  strings.TrimSpace(os.Getenv("LEC_DOC_INTERNAL_TOKEN")),
		LecDocPublicURL:      strings.TrimRight(envOr("LEC_DOC_PUBLIC_URL", "https://doc.lecspace.top"), "/"),
		S3Endpoint:           strings.TrimRight(strings.TrimSpace(os.Getenv("LEC_S3_ENDPOINT")), "/"),
		S3Bucket:             envOr("LEC_S3_BUCKET", "lec-public"),
		S3Region:             envOr("LEC_S3_REGION", "us-east-1"),
		S3AccessKey:          strings.TrimSpace(os.Getenv("LEC_S3_ACCESS_KEY")),
		S3SecretKey:          strings.TrimSpace(os.Getenv("LEC_S3_SECRET_KEY")),
		S3PublicBaseURL:      strings.TrimRight(envOr("LEC_S3_PUBLIC_URL", "https://drive.lecspace.top/orbit"), "/"),
		S3KeyPrefix:          strings.Trim(envOr("LEC_S3_KEY_PREFIX", "orbit"), "/"),
	}
}
