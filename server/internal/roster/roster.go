package roster

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/config"
	"github.com/lec-org/lec-orbit/server/internal/db"
)

type Member struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Avatar      string `json:"avatar"`
	IsCaptain   bool   `json:"isCaptain"`
}

type Service struct {
	gdb        *gorm.DB
	cfg        config.Config
	httpClient *http.Client

	mu       sync.Mutex
	m2mToken string
	m2mExp   time.Time
}

func NewService(gdb *gorm.DB, cfg config.Config) *Service {
	return &Service{
		gdb:        gdb,
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 12 * time.Second},
	}
}

func (s *Service) UpsertFromAuth(ctx context.Context, u auth.AuthUser) {
	if u.UserID == "" {
		return
	}
	display := u.DisplayName
	if display == "" {
		display = u.Username
	}
	now := time.Now().UTC()
	updates := map[string]any{
		"is_captain": u.IsCaptain,
		"is_active":  true,
		"updated_at": now,
	}
	if u.Username != "" {
		updates["username"] = u.Username
	}
	if display != "" {
		updates["display_name"] = display
	}
	if u.Avatar != "" {
		updates["avatar"] = u.Avatar
	}
	record := db.OrbitMember{
		UserID:      u.UserID,
		Username:    u.Username,
		DisplayName: display,
		Avatar:      u.Avatar,
		IsCaptain:   u.IsCaptain,
		IsActive:    true,
		UpdatedAt:   now,
	}
	if err := s.gdb.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.Assignments(updates),
		}).
		Create(&record).Error; err != nil {
		log.Printf("[roster] upsert member %s failed: %v", u.UserID, err)
	}
}

func (s *Service) ListActive(ctx context.Context) ([]Member, error) {
	var rows []db.OrbitMember
	if err := s.gdb.WithContext(ctx).
		Where("is_active = ?", true).
		Order("is_captain DESC, display_name ASC, username ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]Member, 0, len(rows))
	for _, r := range rows {
		out = append(out, Member{
			UserID:      r.UserID,
			Username:    r.Username,
			DisplayName: r.DisplayName,
			Avatar:      r.Avatar,
			IsCaptain:   r.IsCaptain,
		})
	}
	return out, nil
}

func (s *Service) StartPeriodicSync(ctx context.Context) {
	if s.cfg.SSOM2MClientID == "" || s.cfg.SSOM2MClientSec == "" {
		log.Printf("[roster] LEC_SSO_M2M_CLIENT_ID 未配置，成员列表将按登录活跃自动同步")
		return
	}
	go func() {
		if err := s.SyncFromLecSSO(ctx); err != nil {
			log.Printf("[roster] 首次同步 LecSSO 成员失败: %v", err)
		}
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.SyncFromLecSSO(ctx); err != nil {
					log.Printf("[roster] 定时同步 LecSSO 成员失败: %v", err)
				}
			}
		}
	}()
}

func (s *Service) fetchM2MToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m2mToken != "" && time.Now().Before(s.m2mExp) {
		return s.m2mToken, nil
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("resource", s.cfg.SSOM2MResource)
	form.Set("scope", "all")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.SSOEendpoint+"/oidc/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(s.cfg.SSOM2MClientID, s.cfg.SSOM2MClientSec)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("换取 LecSSO M2M Token 失败（HTTP %d）: %s", resp.StatusCode, string(body))
	}
	var res struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}
	s.m2mToken = res.AccessToken
	ttl := res.ExpiresIn - 60
	if ttl < 60 {
		ttl = 60
	}
	s.m2mExp = time.Now().Add(time.Duration(ttl) * time.Second)
	return s.m2mToken, nil
}

type logtoOrgUser struct {
	ID                string `json:"id"`
	Username          string `json:"username"`
	Name              string `json:"name"`
	Avatar            string `json:"avatar"`
	IsSuspended       bool   `json:"isSuspended"`
	OrganizationRoles []struct {
		Name string `json:"name"`
	} `json:"organizationRoles"`
}

func (s *Service) SyncFromLecSSO(ctx context.Context) error {
	token, err := s.fetchM2MToken(ctx)
	if err != nil {
		return err
	}
	const pageSize = 100
	var users []logtoOrgUser
	for page := 1; page <= 20; page++ {
		endpoint := fmt.Sprintf("%s/api/organizations/%s/users?page=%d&page_size=%d", s.cfg.SSOEendpoint, url.PathEscape(s.cfg.SSOOrgID), page, pageSize)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		resp, err := s.httpClient.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			resp.Body.Close()
			return fmt.Errorf("拉取 LecSSO 组织成员失败（HTTP %d）: %s", resp.StatusCode, string(body))
		}
		var batch []logtoOrgUser
		decodeErr := json.NewDecoder(resp.Body).Decode(&batch)
		resp.Body.Close()
		if decodeErr != nil {
			return decodeErr
		}
		users = append(users, batch...)
		if len(batch) < pageSize {
			break
		}
	}
	activeIDs := make([]string, 0, len(users))
	now := time.Now().UTC()
	for _, u := range users {
		if u.ID == "" || u.IsSuspended {
			continue
		}
		roleNames := make([]string, 0, len(u.OrganizationRoles))
		for _, r := range u.OrganizationRoles {
			roleNames = append(roleNames, r.Name)
		}
		display := u.Name
		if display == "" {
			display = u.Username
		}
		record := db.OrbitMember{
			UserID:      u.ID,
			Username:    u.Username,
			DisplayName: display,
			Avatar:      u.Avatar,
			IsCaptain:   auth.IsCaptainRole(roleNames),
			IsActive:    true,
			UpdatedAt:   now,
		}
		if err := s.gdb.WithContext(ctx).
			Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "user_id"}},
				DoUpdates: clause.AssignmentColumns([]string{
					"username", "display_name", "avatar", "is_captain", "is_active", "updated_at",
				}),
			}).
			Create(&record).Error; err != nil {
			log.Printf("[roster] sync user %s failed: %v", u.ID, err)
			continue
		}
		activeIDs = append(activeIDs, u.ID)
	}
	if len(activeIDs) > 0 {
		_ = s.gdb.WithContext(ctx).Model(&db.OrbitMember{}).
			Where("user_id NOT IN ?", activeIDs).
			Update("is_active", false).Error
	}
	log.Printf("[roster] synced %d active studio members from LecSSO", len(activeIDs))
	return nil
}
