package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/db"
	"github.com/lec-org/lec-orbit/server/internal/miniapp"
	"github.com/lec-org/lec-orbit/server/internal/ws"
)

const (
	miniAppKVMaxValueBytes = 64 * 1024
	miniAppKVMaxTotalBytes = 1024 * 1024
)

var sha256HexPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

type miniAppVersionDTO struct {
	ID           string           `json:"id"`
	AppID        string           `json:"appId"`
	Version      string           `json:"version"`
	Channel      string           `json:"channel"`
	Status       string           `json:"status"`
	SourceType   string           `json:"sourceType"`
	BundleURL    string           `json:"bundleUrl"`
	BundleSHA256 string           `json:"bundleSha256"`
	BundleSize   int64            `json:"bundleSize"`
	Manifest     miniapp.Manifest `json:"manifest"`
	Changelog    string           `json:"changelog"`
	UploaderID   string           `json:"uploaderId"`
	ReviewerID   *string          `json:"reviewerId,omitempty"`
	ReviewNote   *string          `json:"reviewNote,omitempty"`
	CreatedAt    time.Time        `json:"createdAt"`
	ReviewedAt   *time.Time       `json:"reviewedAt,omitempty"`
}

type miniAppCatalogDTO struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Type          string             `json:"type"`
	Engine        string             `json:"engine"`
	Description   string             `json:"description"`
	IconURL       string             `json:"iconUrl"`
	Tags          []string           `json:"tags"`
	OwnerID       string             `json:"ownerId"`
	OwnerName     string             `json:"ownerName"`
	OwnerAvatar   string             `json:"ownerAvatar"`
	Status        string             `json:"status"`
	FeaturedRank  int                `json:"featuredRank"`
	PlayCount     int64              `json:"playCount"`
	ActiveVersion *miniAppVersionDTO `json:"activeVersion,omitempty"`
	LatestVersion *miniAppVersionDTO `json:"latestVersion,omitempty"`
	CreatedAt     time.Time          `json:"createdAt"`
	UpdatedAt     time.Time          `json:"updatedAt"`
}

type miniAppDetailDTO struct {
	miniAppCatalogDTO
	Versions []miniAppVersionDTO `json:"versions"`
}

func toVersionDTO(v db.MiniAppVersion) miniAppVersionDTO {
	var manifest miniapp.Manifest
	_ = json.Unmarshal([]byte(v.ManifestJSON), &manifest)
	return miniAppVersionDTO{
		ID:           v.ID.String(),
		AppID:        v.AppID,
		Version:      v.Version,
		Channel:      v.Channel,
		Status:       v.Status,
		SourceType:   v.SourceType,
		BundleURL:    v.BundleURL,
		BundleSHA256: v.BundleSHA256,
		BundleSize:   v.BundleSize,
		Manifest:     manifest,
		Changelog:    v.Changelog,
		UploaderID:   v.UploaderID,
		ReviewerID:   v.ReviewerID,
		ReviewNote:   v.ReviewNote,
		CreatedAt:    v.CreatedAt,
		ReviewedAt:   v.ReviewedAt,
	}
}

func toCatalogDTO(a db.MiniApp, active, latest *db.MiniAppVersion) miniAppCatalogDTO {
	var tags []string
	_ = json.Unmarshal([]byte(a.TagsJSON), &tags)
	if tags == nil {
		tags = []string{}
	}
	dto := miniAppCatalogDTO{
		ID:           a.ID,
		Name:         a.Name,
		Type:         a.Type,
		Engine:       a.Engine,
		Description:  a.Description,
		IconURL:      a.IconURL,
		Tags:         tags,
		OwnerID:      a.OwnerID,
		OwnerName:    a.OwnerName,
		OwnerAvatar:  a.OwnerAvatar,
		Status:       a.Status,
		FeaturedRank: a.FeaturedRank,
		PlayCount:    a.PlayCount,
		CreatedAt:    a.CreatedAt,
		UpdatedAt:    a.UpdatedAt,
	}
	if active != nil {
		v := toVersionDTO(*active)
		dto.ActiveVersion = &v
	}
	if latest != nil {
		v := toVersionDTO(*latest)
		dto.LatestVersion = &v
	}
	return dto
}

func (s *Server) handleListMiniApps(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	ctx := c.Request.Context()

	q := s.gdb.WithContext(ctx).Model(&db.MiniApp{})
	if t := strings.TrimSpace(c.Query("type")); t == "miniapp" || t == "minigame" {
		q = q.Where("type = ?", t)
	}
	if eng := strings.TrimSpace(c.Query("engine")); eng != "" && eng != "all" {
		q = q.Where("engine = ?", eng)
	}
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		like := "%" + kw + "%"
		q = q.Where("name ILIKE ? OR description ILIKE ? OR id ILIKE ?", like, like, like)
	}
	mineOnly := c.Query("mine") == "1" || c.Query("mine") == "true"
	pendingOnly := c.Query("pending") == "1" || c.Query("pending") == "true"

	if mineOnly {
		q = q.Where("owner_id = ?", user.UserID)
	} else if !user.IsCaptain {
		// 普通成员仅可见已上架应用及自己创建的作品
		q = q.Where("status = ? OR owner_id = ?", "published", user.UserID)
	}

	var apps []db.MiniApp
	if err := q.Order("featured_rank DESC, play_count DESC, updated_at DESC").Find(&apps).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询工坊应用列表失败"})
		return
	}

	appIDs := make([]string, 0, len(apps))
	for _, a := range apps {
		appIDs = append(appIDs, a.ID)
	}

	versionByID := make(map[uuid.UUID]db.MiniAppVersion)
	latestByApp := make(map[string]db.MiniAppVersion)
	pendingByApp := make(map[string]bool)

	if len(appIDs) > 0 {
		var versions []db.MiniAppVersion
		if err := s.gdb.WithContext(ctx).
			Where("app_id IN ?", appIDs).
			Order("created_at DESC").
			Find(&versions).Error; err == nil {
			for _, v := range versions {
				versionByID[v.ID] = v
				if _, exists := latestByApp[v.AppID]; !exists {
					latestByApp[v.AppID] = v
				}
				if v.Status == "pending" {
					pendingByApp[v.AppID] = true
				}
			}
		}
	}

	items := make([]miniAppCatalogDTO, 0, len(apps))
	for _, a := range apps {
		if pendingOnly && !pendingByApp[a.ID] {
			continue
		}
		var activePtr *db.MiniAppVersion
		if a.ActiveVersionID != nil {
			if hit, ok := versionByID[*a.ActiveVersionID]; ok {
				cp := hit
				activePtr = &cp
			}
		}
		var latestPtr *db.MiniAppVersion
		if hit, ok := latestByApp[a.ID]; ok {
			if user.IsCaptain || a.OwnerID == user.UserID || hit.Status == "approved" {
				cp := hit
				latestPtr = &cp
			}
		}
		items = append(items, toCatalogDTO(a, activePtr, latestPtr))
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (s *Server) handleGetMiniApp(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	ctx := c.Request.Context()

	var app db.MiniApp
	if err := s.gdb.WithContext(ctx).First(&app, "id = ?", appID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "工坊应用不存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取应用详情失败"})
		return
	}

	if app.Status != "published" && !user.IsCaptain && app.OwnerID != user.UserID {
		c.JSON(http.StatusForbidden, gin.H{"error": "无权查看尚未上架的应用"})
		return
	}

	var versions []db.MiniAppVersion
	vq := s.gdb.WithContext(ctx).Where("app_id = ?", app.ID).Order("created_at DESC").Limit(20)
	if !user.IsCaptain && app.OwnerID != user.UserID {
		vq = vq.Where("status = ?", "approved")
	}
	_ = vq.Find(&versions).Error

	var activePtr *db.MiniAppVersion
	var latestPtr *db.MiniAppVersion
	vDTOs := make([]miniAppVersionDTO, 0, len(versions))
	for i := range versions {
		vDTOs = append(vDTOs, toVersionDTO(versions[i]))
		if i == 0 {
			latestPtr = &versions[i]
		}
		if app.ActiveVersionID != nil && versions[i].ID == *app.ActiveVersionID {
			activePtr = &versions[i]
		}
	}

	c.JSON(http.StatusOK, miniAppDetailDTO{
		miniAppCatalogDTO: toCatalogDTO(app, activePtr, latestPtr),
		Versions:          vDTOs,
	})
}

func (s *Server) handleUploadMiniAppBundle(c *gin.Context) {
	if s.uploader == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "RustFS 对象存储尚未配置，无法上传构建包"})
		return
	}
	user, _ := auth.CurrentUser(c)
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请上传构建包文件（字段名 file，格式 .zip/.lecapp）"})
		return
	}
	if fh.Size <= 0 || fh.Size > miniapp.MaxBundleBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "构建包体积需在 1B ~ 100MB 之间；更大体积请改用 GitHub Releases 导入"})
		return
	}

	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "读取上传文件失败"})
		return
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, miniapp.MaxBundleBytes+1))
	if err != nil || int64(len(data)) > miniapp.MaxBundleBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "构建包超出 100MB 限制"})
		return
	}

	validated, err := miniapp.ValidateZipBundle(data)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	channel := strings.TrimSpace(c.PostForm("channel"))
	if channel != "release" {
		channel = "preview"
	}
	changelog := strings.TrimSpace(c.PostForm("changelog"))
	directPublish := user.IsCaptain && (c.PostForm("directPublish") == "true" || c.PostForm("directPublish") == "1")

	ctx := c.Request.Context()
	// 校验所有权
	var existing db.MiniApp
	err = s.gdb.WithContext(ctx).First(&existing, "id = ?", validated.Manifest.ID).Error
	isNewApp := errors.Is(err, gorm.ErrRecordNotFound)
	if err != nil && !isNewApp {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "检查应用归属失败"})
		return
	}
	if !isNewApp && existing.OwnerID != user.UserID && !user.IsCaptain {
		c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("应用 ID %q 已被其他成员注册", validated.Manifest.ID)})
		return
	}

	// 上传构建包到 RustFS
	safeVer := strings.ReplaceAll(validated.Manifest.Version, "/", "_")
	bundleRelKey := filepath.ToSlash(fmt.Sprintf("miniapps/%s/%s-%s.zip", validated.Manifest.ID, safeVer, validated.SHA256[:10]))
	bundleURL, err := s.uploader.PutPublicObject(ctx, bundleRelKey, data, "application/zip")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "上传构建包至 RustFS 失败：" + err.Error()})
		return
	}

	iconURL := existing.IconURL
	if len(validated.IconBytes) > 0 {
		iconKey := filepath.ToSlash(fmt.Sprintf("miniapps/%s/icon-%s%s", validated.Manifest.ID, validated.SHA256[:8], validated.IconExt))
		if uploadedIcon, ierr := s.uploader.PutPublicObject(ctx, iconKey, validated.IconBytes, validated.IconContentType); ierr == nil {
			iconURL = uploadedIcon
		}
	}

	dto, err := s.persistMiniAppVersion(ctx, user, persistVersionInput{
		Manifest:      validated.Manifest,
		ManifestJSON:  validated.ManifestJSON,
		IconURL:       iconURL,
		SourceType:    "rustfs",
		BundleURL:     bundleURL,
		BundleKey:     bundleRelKey,
		BundleSHA256:  validated.SHA256,
		BundleSize:    validated.CompressedBytes,
		Channel:       channel,
		Changelog:     changelog,
		DirectPublish: directPublish,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, dto)
}

func (s *Server) handleImportGitHubMiniApp(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	var req struct {
		BundleURL     string           `json:"bundleUrl" binding:"required"`
		BundleSHA256  string           `json:"bundleSha256" binding:"required"`
		BundleSize    int64            `json:"bundleSize"`
		IconURL       string           `json:"iconUrl"`
		Channel       string           `json:"channel"`
		Changelog     string           `json:"changelog"`
		DirectPublish bool             `json:"directPublish"`
		Manifest      miniapp.Manifest `json:"manifest" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "导入参数不完整"})
		return
	}
	if !miniapp.IsAllowedGitHubReleaseURL(req.BundleURL) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "仅允许导入来自 https://github.com 或 githubusercontent.com 的 Releases ZIP 链接"})
		return
	}
	sha := strings.ToLower(strings.TrimSpace(req.BundleSHA256))
	if !sha256HexPattern.MatchString(sha) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请提供 64 位十六进制 SHA256 校验值以确保完整性"})
		return
	}
	if err := miniapp.NormalizeAndValidateManifest(&req.Manifest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()
	var existing db.MiniApp
	err := s.gdb.WithContext(ctx).First(&existing, "id = ?", req.Manifest.ID).Error
	isNewApp := errors.Is(err, gorm.ErrRecordNotFound)
	if err != nil && !isNewApp {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "检查应用归属失败"})
		return
	}
	if !isNewApp && existing.OwnerID != user.UserID && !user.IsCaptain {
		c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("应用 ID %q 已被其他成员注册", req.Manifest.ID)})
		return
	}

	manifestBytes, _ := json.Marshal(req.Manifest)
	channel := strings.TrimSpace(req.Channel)
	if channel != "release" {
		channel = "preview"
	}
	iconURL := strings.TrimSpace(req.IconURL)
	if iconURL == "" {
		iconURL = existing.IconURL
	}

	dto, err := s.persistMiniAppVersion(ctx, user, persistVersionInput{
		Manifest:      req.Manifest,
		ManifestJSON:  string(manifestBytes),
		IconURL:       iconURL,
		SourceType:    "github",
		BundleURL:     strings.TrimSpace(req.BundleURL),
		BundleSHA256:  sha,
		BundleSize:    req.BundleSize,
		Channel:       channel,
		Changelog:     strings.TrimSpace(req.Changelog),
		DirectPublish: user.IsCaptain && req.DirectPublish,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, dto)
}

type persistVersionInput struct {
	Manifest      miniapp.Manifest
	ManifestJSON  string
	IconURL       string
	SourceType    string
	BundleURL     string
	BundleKey     string
	BundleSHA256  string
	BundleSize    int64
	Channel       string
	Changelog     string
	DirectPublish bool
}

func (s *Server) persistMiniAppVersion(
	ctx context.Context,
	user auth.AuthUser,
	in persistVersionInput,
) (miniAppCatalogDTO, error) {
	now := time.Now().UTC()
	verID := uuid.New()
	status := "pending"
	var reviewerID *string
	var reviewedAt *time.Time
	if in.DirectPublish {
		status = "approved"
		uid := user.UserID
		reviewerID = &uid
		reviewedAt = &now
	}

	tagsJSON, _ := json.Marshal(in.Manifest.Tags)
	ver := db.MiniAppVersion{
		ID:           verID,
		AppID:        in.Manifest.ID,
		Version:      in.Manifest.Version,
		Channel:      in.Channel,
		Status:       status,
		SourceType:   in.SourceType,
		BundleURL:    in.BundleURL,
		BundleKey:    in.BundleKey,
		BundleSHA256: in.BundleSHA256,
		BundleSize:   in.BundleSize,
		ManifestJSON: in.ManifestJSON,
		Changelog:    in.Changelog,
		UploaderID:   user.UserID,
		ReviewerID:   reviewerID,
		CreatedAt:    now,
		ReviewedAt:   reviewedAt,
	}

	var savedApp db.MiniApp
	err := s.gdb.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var app db.MiniApp
		findErr := tx.First(&app, "id = ?", in.Manifest.ID).Error
		if errors.Is(findErr, gorm.ErrRecordNotFound) {
			app = db.MiniApp{
				ID:          in.Manifest.ID,
				Name:        in.Manifest.Name,
				Type:        in.Manifest.Type,
				Engine:      in.Manifest.Engine,
				Description: in.Manifest.Description,
				IconURL:     in.IconURL,
				TagsJSON:    string(tagsJSON),
				OwnerID:     user.UserID,
				OwnerName:   user.DisplayName,
				OwnerAvatar: user.Avatar,
				Status:      "draft",
				CreatedAt:   now,
				UpdatedAt:   now,
			}
			if in.DirectPublish {
				app.Status = "published"
				app.ActiveVersionID = &verID
			}
			if err := tx.Create(&app).Error; err != nil {
				return fmt.Errorf("创建应用记录失败：%w", err)
			}
		} else if findErr != nil {
			return findErr
		} else {
			updates := map[string]any{
				"name":        in.Manifest.Name,
				"type":        in.Manifest.Type,
				"engine":      in.Manifest.Engine,
				"description": in.Manifest.Description,
				"tags_json":   string(tagsJSON),
				"updated_at":  now,
			}
			if in.IconURL != "" {
				updates["icon_url"] = in.IconURL
			}
			if in.DirectPublish {
				updates["status"] = "published"
				updates["active_version_id"] = verID
				app.Status = "published"
				app.ActiveVersionID = &verID
			}
			if err := tx.Model(&app).Updates(updates).Error; err != nil {
				return fmt.Errorf("更新应用元数据失败：%w", err)
			}
			app.Name = in.Manifest.Name
			app.Type = in.Manifest.Type
			app.Engine = in.Manifest.Engine
			app.Description = in.Manifest.Description
			if in.IconURL != "" {
				app.IconURL = in.IconURL
			}
			app.TagsJSON = string(tagsJSON)
			app.UpdatedAt = now
		}

		if err := tx.Create(&ver).Error; err != nil {
			return fmt.Errorf("写入版本记录失败：%w", err)
		}
		savedApp = app
		return nil
	})
	if err != nil {
		return miniAppCatalogDTO{}, err
	}

	// 若提交待审核，通知所有在岗队长
	if status == "pending" && in.Channel == "release" {
		s.notifyCaptainsOfAppSubmission(ctx, savedApp, ver, user.DisplayName)
	}

	var activePtr *db.MiniAppVersion
	if in.DirectPublish {
		activePtr = &ver
	}
	return toCatalogDTO(savedApp, activePtr, &ver), nil
}

func (s *Server) notifyCaptainsOfAppSubmission(
	ctx context.Context,
	app db.MiniApp,
	ver db.MiniAppVersion,
	uploaderName string,
) {
	var captains []db.OrbitMember
	if err := s.gdb.WithContext(ctx).Where("is_active = TRUE AND is_captain = TRUE").Find(&captains).Error; err != nil {
		return
	}
	for _, cap := range captains {
		uid := cap.UserID
		notif, err := s.insertNotification(ctx, createNotifInput{
			SourceApp: "orbit",
			EventType: "hub.version.pending",
			Title:     fmt.Sprintf("工坊上新待审核：《%s》v%s", app.Name, ver.Version),
			Body:      fmt.Sprintf("%s 提交了 %s（%s），请前往「工坊 → 待审核」试玩并决定是否上架。", uploaderName, app.Name, app.Engine),
			Payload: map[string]any{
				"appId":     app.ID,
				"versionId": ver.ID.String(),
				"version":   ver.Version,
			},
			TargetUserID: &uid,
		})
		if err == nil {
			s.hub.PushToUser(ctx, uid, ws.Event{Type: "notification.created", Payload: notif})
		}
	}
}

func (s *Server) handleReviewMiniAppVersion(c *gin.Context) {
	reviewer, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	verID, err := uuid.Parse(strings.TrimSpace(c.Param("versionId")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的版本 ID"})
		return
	}
	var req struct {
		Decision string `json:"decision" binding:"required"`
		Note     string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Decision != "approve" && req.Decision != "reject") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "decision 必须是 approve 或 reject"})
		return
	}

	ctx := c.Request.Context()
	var app db.MiniApp
	var ver db.MiniAppVersion
	if err := s.gdb.WithContext(ctx).First(&app, "id = ?", appID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "应用不存在"})
		return
	}
	if err := s.gdb.WithContext(ctx).First(&ver, "id = ? AND app_id = ?", verID, appID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "目标版本不存在"})
		return
	}

	now := time.Now().UTC()
	note := strings.TrimSpace(req.Note)
	nextStatus := "rejected"
	if req.Decision == "approve" {
		nextStatus = "approved"
	}

	err = s.gdb.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&ver).Updates(map[string]any{
			"status":      nextStatus,
			"reviewer_id": reviewer.UserID,
			"review_note": note,
			"reviewed_at": now,
		}).Error; err != nil {
			return err
		}
		if req.Decision == "approve" {
			return tx.Model(&app).Updates(map[string]any{
				"status":            "published",
				"active_version_id": ver.ID,
				"updated_at":        now,
			}).Error
		}
		return nil
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "更新审核状态失败"})
		return
	}

	// 通知开发者审核结果
	targetUID := ver.UploaderID
	title := fmt.Sprintf("《%s》v%s 已通过审核并上架", app.Name, ver.Version)
	body := fmt.Sprintf("审核人：%s。全员现在可以在 Orbit 工坊中打开体验！", reviewer.DisplayName)
	if req.Decision == "reject" {
		title = fmt.Sprintf("《%s》v%s 审核未通过", app.Name, ver.Version)
		body = fmt.Sprintf("审核人：%s。意见：%s", reviewer.DisplayName, note)
	}
	if notif, nerr := s.insertNotification(ctx, createNotifInput{
		SourceApp:    "orbit",
		EventType:    "hub.version.reviewed",
		Title:        title,
		Body:         body,
		Payload:      map[string]any{"appId": app.ID, "versionId": ver.ID.String(), "decision": req.Decision},
		TargetUserID: &targetUID,
	}); nerr == nil {
		s.hub.PushToUser(ctx, targetUID, ws.Event{Type: "notification.created", Payload: notif})
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "appId": app.ID, "versionId": ver.ID.String(), "status": nextStatus})
}

func (s *Server) handleUpdateMiniAppStatus(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	var req struct {
		Status          string `json:"status"`
		ActiveVersionID string `json:"activeVersionId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的请求体"})
		return
	}

	ctx := c.Request.Context()
	var app db.MiniApp
	if err := s.gdb.WithContext(ctx).First(&app, "id = ?", appID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "应用不存在"})
		return
	}
	if !user.IsCaptain && app.OwnerID != user.UserID {
		c.JSON(http.StatusForbidden, gin.H{"error": "仅作者或队长可执行此操作"})
		return
	}

	updates := map[string]any{"updated_at": time.Now().UTC()}
	if req.Status != "" {
		if req.Status != "published" && req.Status != "suspended" && req.Status != "draft" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的应用状态"})
			return
		}
		if req.Status == "published" && !user.IsCaptain {
			c.JSON(http.StatusForbidden, gin.H{"error": "普通成员不能直接改为已上架状态"})
			return
		}
		updates["status"] = req.Status
	}
	if req.ActiveVersionID != "" {
		vid, err := uuid.Parse(req.ActiveVersionID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的版本 ID"})
			return
		}
		var ver db.MiniAppVersion
		if err := s.gdb.WithContext(ctx).First(&ver, "id = ? AND app_id = ? AND status = ?", vid, appID, "approved").Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "仅可回滚到已审核通过的历史版本"})
			return
		}
		updates["active_version_id"] = vid
	}

	if err := s.gdb.WithContext(ctx).Model(&app).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "更新应用状态失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleRecordMiniAppPlay(c *gin.Context) {
	appID := strings.TrimSpace(c.Param("id"))
	_ = s.gdb.WithContext(c.Request.Context()).
		Model(&db.MiniApp{}).
		Where("id = ?", appID).
		UpdateColumn("play_count", gorm.Expr("play_count + 1")).Error
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ── 托管云存档 KV API（按 app_id + user_id 隔离） ──

func (s *Server) handleListMiniAppKVKeys(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	var keys []string
	if err := s.gdb.WithContext(c.Request.Context()).
		Model(&db.MiniAppKV{}).
		Where("app_id = ? AND user_id = ?", appID, user.UserID).
		Order("key ASC").
		Pluck("key", &keys).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取云存档键列表失败"})
		return
	}
	if keys == nil {
		keys = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"keys": keys})
}

func (s *Server) handleGetMiniAppKV(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	key := strings.TrimSpace(c.Param("key"))

	var item db.MiniAppKV
	err := s.gdb.WithContext(c.Request.Context()).
		First(&item, "app_id = ? AND user_id = ? AND key = ?", appID, user.UserID, key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "键不存在"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取云存档失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"key": item.Key, "value": json.RawMessage(item.ValueJSON), "updatedAt": item.UpdatedAt})
}

func (s *Server) handleSetMiniAppKV(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	key := strings.TrimSpace(c.Param("key"))
	if key == "" || len(key) > 128 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "存档键长度需在 1~128 字符之间"})
		return
	}

	var req struct {
		Value json.RawMessage `json:"value"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请提供合法的 JSON value"})
		return
	}
	rawVal := bytesTrimOrNull(req.Value)
	if len(rawVal) > miniAppKVMaxValueBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "单条云存档不能超过 64 KB"})
		return
	}

	ctx := c.Request.Context()
	var usedBytes int64
	_ = s.gdb.WithContext(ctx).
		Model(&db.MiniAppKV{}).
		Where("app_id = ? AND user_id = ? AND key <> ?", appID, user.UserID, key).
		Select("COALESCE(SUM(size_bytes), 0)").
		Scan(&usedBytes).Error
	if usedBytes+int64(len(rawVal)) > miniAppKVMaxTotalBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "单应用云存档总配额已达 1 MB 上限"})
		return
	}

	rec := db.MiniAppKV{
		AppID:     appID,
		UserID:    user.UserID,
		Key:       key,
		ValueJSON: string(rawVal),
		SizeBytes: len(rawVal),
		UpdatedAt: time.Now().UTC(),
	}
	if err := s.gdb.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "app_id"}, {Name: "user_id"}, {Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value_json", "size_bytes", "updated_at"}),
	}).Create(&rec).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "保存云存档失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "key": key, "sizeBytes": rec.SizeBytes})
}

func (s *Server) handleDeleteMiniAppKV(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	key := strings.TrimSpace(c.Param("key"))
	if err := s.gdb.WithContext(c.Request.Context()).
		Delete(&db.MiniAppKV{}, "app_id = ? AND user_id = ? AND key = ?", appID, user.UserID, key).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "删除云存档失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func bytesTrimOrNull(raw json.RawMessage) []byte {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return []byte("null")
	}
	return []byte(trimmed)
}
