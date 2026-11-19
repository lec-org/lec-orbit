package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/lec-org/lec-orbit/server/internal/config"
)

const userContextKey = "orbit_auth_user"

// AuthUser 表示通过 LecSSO 校验后的当前成员身份。
type AuthUser struct {
	UserID        string   `json:"userId"`
	Username      string   `json:"username"`
	DisplayName   string   `json:"displayName"`
	Avatar        string   `json:"avatar"`
	Organizations []string `json:"organizations"`
	Roles         []string `json:"roles"`
	IsStudio      bool     `json:"isStudio"`
	IsCaptain     bool     `json:"isCaptain"`
}

type cachedOpaqueEntry struct {
	user      AuthUser
	expiresAt time.Time
}

type Verifier struct {
	cfg        config.Config
	httpClient *http.Client
	jwksOnce   sync.Once
	jwks       keyfunc.Keyfunc
	jwksErr    error

	mu          sync.RWMutex
	opaqueCache map[string]cachedOpaqueEntry
}

func NewVerifier(cfg config.Config) *Verifier {
	return &Verifier{
		cfg:         cfg,
		httpClient:  &http.Client{Timeout: 8 * time.Second},
		opaqueCache: make(map[string]cachedOpaqueEntry),
	}
}

func (v *Verifier) ensureJWKS(ctx context.Context) (keyfunc.Keyfunc, error) {
	v.jwksOnce.Do(func() {
		jwksURL := strings.TrimRight(v.cfg.SSOIssuer, "/") + "/jwks"
		kf, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
		if err != nil {
			v.jwksErr = err
			return
		}
		v.jwks = kf
	})
	return v.jwks, v.jwksErr
}

func IsCaptainRole(roles []string) bool {
	for _, raw := range roles {
		part := raw
		if idx := strings.LastIndex(raw, ":"); idx >= 0 {
			part = raw[idx+1:]
		}
		lower := strings.ToLower(strings.TrimSpace(part))
		if lower == "captain" || lower == "admin" || lower == "lec-captain" {
			return true
		}
	}
	return false
}

func (v *Verifier) VerifyToken(ctx context.Context, rawToken string) (AuthUser, error) {
	token := strings.TrimSpace(rawToken)
	if token == "" {
		return AuthUser{}, errors.New("缺少认证令牌")
	}
	if strings.Count(token, ".") == 2 {
		return v.verifyJWT(ctx, token)
	}
	return v.verifyOpaqueViaUserinfo(ctx, token)
}

func (v *Verifier) verifyJWT(ctx context.Context, tokenStr string) (AuthUser, error) {
	kf, err := v.ensureJWKS(ctx)
	if err != nil {
		return AuthUser{}, fmt.Errorf("初始化 LecSSO JWKS 失败: %w", err)
	}
	claims := jwt.MapClaims{}
	parsed, err := jwt.ParseWithClaims(tokenStr, claims, kf.Keyfunc, jwt.WithIssuer(v.cfg.SSOIssuer))
	if err != nil || !parsed.Valid {
		return AuthUser{}, errors.New("JWT 验签失败或已过期")
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return AuthUser{}, errors.New("JWT 缺少 sub")
	}
	orgID, _ := claims["organization_id"].(string)
	orgs := extractStringSlice(claims["organizations"])
	if orgID != "" && !containsString(orgs, orgID) {
		orgs = append(orgs, orgID)
	}
	roles := extractStringSlice(claims["organization_roles"])
	scopeStr, _ := claims["scope"].(string)
	isCaptain := IsCaptainRole(roles) || strings.Contains(" "+scopeStr+" ", " studio:admin:access ")

	username, _ := claims["username"].(string)
	name, _ := claims["name"].(string)
	avatar, _ := claims["picture"].(string)
	if name == "" {
		name = username
	}
	return AuthUser{
		UserID:        sub,
		Username:      username,
		DisplayName:   name,
		Avatar:        avatar,
		Organizations: orgs,
		Roles:         roles,
		IsStudio:      orgID == v.cfg.SSOOrgID || containsString(orgs, v.cfg.SSOOrgID),
		IsCaptain:     isCaptain,
	}, nil
}

func (v *Verifier) verifyOpaqueViaUserinfo(ctx context.Context, tokenStr string) (AuthUser, error) {
	sum := sha256.Sum256([]byte(tokenStr))
	cacheKey := hex.EncodeToString(sum[:])

	v.mu.RLock()
	if entry, ok := v.opaqueCache[cacheKey]; ok && time.Now().Before(entry.expiresAt) {
		v.mu.RUnlock()
		return entry.user, nil
	}
	v.mu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(v.cfg.SSOIssuer, "/")+"/me", nil)
	if err != nil {
		return AuthUser{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	req.Header.Set("Accept", "application/json")
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return AuthUser{}, fmt.Errorf("访问 LecSSO userinfo 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return AuthUser{}, fmt.Errorf("LecSSO 令牌无效（HTTP %d）: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return AuthUser{}, fmt.Errorf("解析 LecSSO userinfo 失败: %w", err)
	}
	sub, _ := payload["sub"].(string)
	if sub == "" {
		return AuthUser{}, errors.New("userinfo 缺少 sub")
	}
	orgs := extractStringSlice(payload["organizations"])
	roles := extractStringSlice(payload["organization_roles"])
	username, _ := payload["username"].(string)
	name, _ := payload["name"].(string)
	avatar, _ := payload["picture"].(string)
	if name == "" {
		name = username
	}
	user := AuthUser{
		UserID:        sub,
		Username:      username,
		DisplayName:   name,
		Avatar:        avatar,
		Organizations: orgs,
		Roles:         roles,
		IsStudio:      containsString(orgs, v.cfg.SSOOrgID),
		IsCaptain:     IsCaptainRole(roles),
	}

	v.mu.Lock()
	if len(v.opaqueCache) > 2000 {
		v.opaqueCache = make(map[string]cachedOpaqueEntry)
	}
	v.opaqueCache[cacheKey] = cachedOpaqueEntry{
		user:      user,
		expiresAt: time.Now().Add(60 * time.Second),
	}
	v.mu.Unlock()
	return user, nil
}

// Middleware 校验 Authorization Bearer 令牌（或 WS 查询参数 token）并注入 AuthUser。
func (v *Verifier) Middleware(onAuthenticated func(ctx context.Context, user AuthUser)) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractBearerToken(c)
		user, err := v.VerifyToken(c.Request.Context(), token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		if !user.IsStudio && !user.IsCaptain {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "仅限工作室正式成员访问"})
			return
		}
		c.Set(userContextKey, user)
		if onAuthenticated != nil {
			go onAuthenticated(context.Background(), user)
		}
		c.Next()
	}
}

func RequireCaptain() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := CurrentUser(c)
		if !ok || !user.IsCaptain {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "仅队长/管理员可执行该操作"})
			return
		}
		c.Next()
	}
}

func CurrentUser(c *gin.Context) (AuthUser, bool) {
	raw, exists := c.Get(userContextKey)
	if !exists {
		return AuthUser{}, false
	}
	user, ok := raw.(AuthUser)
	return user, ok
}

func extractBearerToken(c *gin.Context) string {
	authHeader := strings.TrimSpace(c.GetHeader("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[7:])
	}
	return strings.TrimSpace(c.Query("token"))
}

func extractStringSlice(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}
