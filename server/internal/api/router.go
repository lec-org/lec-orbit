package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/microcosm-cc/bluemonday"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/config"
	"github.com/lec-org/lec-orbit/server/internal/db"
	"github.com/lec-org/lec-orbit/server/internal/docbridge"
	"github.com/lec-org/lec-orbit/server/internal/roster"
	"github.com/lec-org/lec-orbit/server/internal/storage"
	"github.com/lec-org/lec-orbit/server/internal/ws"
)

type Server struct {
	cfg       config.Config
	gdb       *gorm.DB
	verifier  *auth.Verifier
	roster    *roster.Service
	hub       *ws.Hub
	uploader  *storage.S3Uploader
	docClient *docbridge.Client
	sanitizer *bluemonday.Policy
	stripper  *bluemonday.Policy
}

func NewServer(
	cfg config.Config,
	gdb *gorm.DB,
	verifier *auth.Verifier,
	rosterSvc *roster.Service,
	hub *ws.Hub,
	uploader *storage.S3Uploader,
	docClient *docbridge.Client,
) *Server {
	policy := bluemonday.UGCPolicy()
	policy.AllowAttrs("class").Matching(regexp.MustCompile(`^[a-zA-Z0-9_\-\s]+$`)).Globally()
	policy.AllowAttrs("src", "alt", "title", "width", "height").OnElements("img")
	policy.AllowURLSchemes("http", "https")

	return &Server{
		cfg:       cfg,
		gdb:       gdb,
		verifier:  verifier,
		roster:    rosterSvc,
		hub:       hub,
		uploader:  uploader,
		docClient: docClient,
		sanitizer: policy,
		stripper:  bluemonday.StrictPolicy(),
	}
}

func (s *Server) SanitizeHTML(raw string) (safeHTML string, plainText string) {
	safeHTML = strings.TrimSpace(s.sanitizer.Sanitize(raw))
	plainText = strings.TrimSpace(strings.Join(strings.Fields(s.stripper.Sanitize(safeHTML)), " "))
	return safeHTML, plainText
}

func (s *Server) Router() *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery(), corsMiddleware())

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "lec-orbit-server"})
	})

	v1 := r.Group("/api/v1")
	v1.Use(s.verifier.Middleware(func(ctx context.Context, user auth.AuthUser) {
		s.roster.UpsertFromAuth(ctx, user)
	}))
	{
		v1.GET("/ws", s.handleWS)
		v1.GET("/me", func(c *gin.Context) {
			user, _ := auth.CurrentUser(c)
			c.JSON(http.StatusOK, user)
		})
		v1.GET("/members", s.handleListMembers)

		// 公告与 IM 风格全员已读/未读回执
		v1.GET("/announcements", s.handleListAnnouncements)
		v1.POST("/announcements", auth.RequireCaptain(), s.handleCreateAnnouncement)
		v1.PATCH("/announcements/:id", auth.RequireCaptain(), s.handleUpdateAnnouncement)
		v1.DELETE("/announcements/:id", auth.RequireCaptain(), s.handleDeleteAnnouncement)
		v1.POST("/announcements/:id/read", s.handleMarkAnnouncementRead)
		v1.GET("/announcements/:id/receipts", s.handleGetAnnouncementReceipts)
		v1.POST("/announcements/:id/remind-unread", auth.RequireCaptain(), s.handleRemindUnread)

		// 队长富文本插图上传（直传统一 RustFS lec-public/orbit/...）
		v1.POST("/uploads/image", auth.RequireCaptain(), s.handleUploadImage)

		// 统一通知中心与交互审批卡片
		v1.GET("/notifications", s.handleListNotifications)
		v1.POST("/notifications/:id/read", s.handleMarkNotificationRead)
		v1.POST("/notifications/read-all", s.handleMarkAllNotificationsRead)
		v1.POST("/notifications/:id/action", s.handleNotificationAction)

		// 云文档编辑权限申请（成员在 Orbit 内发起 -> 实时推卡片给作者）
		v1.POST("/doc-requests", s.handleCreateDocEditRequest)
	}

	// 内部跨应用事件总线（供 LecDoc / LecPunch / Devtron / LecOJ / LecDrive 投递更新与业务事件）
	internal := r.Group("/internal/v1")
	internal.Use(s.requireInternalToken())
	{
		internal.POST("/events", s.handleInternalEvent)
		internal.POST("/webhooks/devtron", s.handleDevtronWebhook)
		internal.POST("/doc-requests", s.handleInternalDocEditRequest)
	}

	return r
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Orbit-Service-Token")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func (s *Server) requireInternalToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		if s.cfg.InternalServiceToken == "" {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "内部事件总线令牌尚未配置"})
			return
		}
		got := strings.TrimSpace(c.GetHeader("X-Orbit-Service-Token"))
		if got == "" {
			got = strings.TrimSpace(c.GetHeader("X-Orbit-Internal-Token"))
		}
		if got == "" {
			got = strings.TrimSpace(c.Query("token"))
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.InternalServiceToken)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "无效的内部服务令牌"})
			return
		}
		c.Next()
	}
}

func (s *Server) handleWS(c *gin.Context) {
	user, ok := auth.CurrentUser(c)
	if !ok {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	s.hub.ServeWS(c.Writer, c.Request, user.UserID)
}

func (s *Server) handleListMembers(c *gin.Context) {
	members, err := s.roster.ListActive(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取成员列表失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": members})
}

type announcementDTO struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	ContentHTML  string    `json:"contentHtml"`
	ContentText  string    `json:"contentText"`
	Pinned       bool      `json:"pinned"`
	AuthorID     string    `json:"authorId"`
	AuthorName   string    `json:"authorName"`
	AuthorAvatar string    `json:"authorAvatar"`
	ReadCount    int       `json:"readCount"`
	TotalCount   int       `json:"totalCount"`
	IsReadByMe   bool      `json:"isReadByMe"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (s *Server) activeMemberCount(ctx context.Context) int {
	var total int64
	_ = s.gdb.WithContext(ctx).Model(&db.OrbitMember{}).Where("is_active = ?", true).Count(&total).Error
	if total < 1 {
		return 1
	}
	return int(total)
}

func (s *Server) handleListAnnouncements(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	ctx := c.Request.Context()
	total := s.activeMemberCount(ctx)

	type rowResult struct {
		ID           string
		Title        string
		ContentHTML  string
		ContentText  string
		Pinned       bool
		AuthorID     string
		AuthorName   string
		AuthorAvatar string
		CreatedAt    time.Time
		UpdatedAt    time.Time
		ReadCount    int
		IsReadByMe   bool
	}
	var rows []rowResult
	err := s.gdb.WithContext(ctx).Raw(`
		SELECT a.id::text AS id, a.title, a.content_html, a.content_text, a.pinned,
		       a.author_id, a.author_name, a.author_avatar, a.created_at, a.updated_at,
		       (SELECT COUNT(*) FROM announcement_receipts r
		        JOIN orbit_members m ON m.user_id = r.user_id AND m.is_active = TRUE
		        WHERE r.announcement_id = a.id) AS read_count,
		       EXISTS (SELECT 1 FROM announcement_receipts r WHERE r.announcement_id = a.id AND r.user_id = ?) AS is_read_by_me
		FROM announcements a
		WHERE a.deleted_at IS NULL
		ORDER BY a.pinned DESC, a.created_at DESC
		LIMIT 50
	`, user.UserID).Scan(&rows).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询公告列表失败"})
		return
	}

	items := make([]announcementDTO, 0, len(rows))
	for _, r := range rows {
		tot := total
		if r.ReadCount > tot {
			tot = r.ReadCount
		}
		items = append(items, announcementDTO{
			ID:           r.ID,
			Title:        r.Title,
			ContentHTML:  r.ContentHTML,
			ContentText:  r.ContentText,
			Pinned:       r.Pinned,
			AuthorID:     r.AuthorID,
			AuthorName:   r.AuthorName,
			AuthorAvatar: r.AuthorAvatar,
			ReadCount:    r.ReadCount,
			TotalCount:   tot,
			IsReadByMe:   r.IsReadByMe,
			CreatedAt:    r.CreatedAt,
			UpdatedAt:    r.UpdatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (s *Server) handleCreateAnnouncement(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	var req struct {
		Title       string `json:"title" binding:"required"`
		ContentHTML string `json:"contentHtml" binding:"required"`
		Pinned      bool   `json:"pinned"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请填写公告标题和正文内容"})
		return
	}
	title := strings.TrimSpace(req.Title)
	safeHTML, plainText := s.SanitizeHTML(req.ContentHTML)
	if title == "" || safeHTML == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "公告标题和正文不能为空"})
		return
	}

	ctx := c.Request.Context()
	now := time.Now().UTC()
	record := db.Announcement{
		ID:           uuid.New(),
		Title:        title,
		ContentHTML:  safeHTML,
		ContentText:  plainText,
		Pinned:       req.Pinned,
		AuthorID:     user.UserID,
		AuthorName:   user.DisplayName,
		AuthorAvatar: user.Avatar,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.gdb.WithContext(ctx).Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "发布公告失败"})
		return
	}
	// 作者发布后默认记为已读
	_ = s.gdb.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&db.AnnouncementReceipt{
			AnnouncementID: record.ID,
			UserID:         user.UserID,
			ReadAt:         now,
		}).Error

	total := s.activeMemberCount(ctx)
	dto := announcementDTO{
		ID:           record.ID.String(),
		Title:        record.Title,
		ContentHTML:  record.ContentHTML,
		ContentText:  record.ContentText,
		Pinned:       record.Pinned,
		AuthorID:     record.AuthorID,
		AuthorName:   record.AuthorName,
		AuthorAvatar: record.AuthorAvatar,
		ReadCount:    1,
		TotalCount:   total,
		IsReadByMe:   true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	s.hub.Broadcast(ctx, ws.Event{Type: "announcement.created", Payload: dto})
	c.JSON(http.StatusCreated, dto)
}

func (s *Server) handleUpdateAnnouncement(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的公告 ID"})
		return
	}
	var req struct {
		Title       *string `json:"title"`
		ContentHTML *string `json:"contentHtml"`
		Pinned      *bool   `json:"pinned"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数格式无效"})
		return
	}

	ctx := c.Request.Context()
	var record db.Announcement
	if err := s.gdb.WithContext(ctx).First(&record, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "公告不存在"})
		return
	}
	if req.Title != nil && strings.TrimSpace(*req.Title) != "" {
		record.Title = strings.TrimSpace(*req.Title)
	}
	if req.ContentHTML != nil {
		safe, plain := s.SanitizeHTML(*req.ContentHTML)
		if safe != "" {
			record.ContentHTML, record.ContentText = safe, plain
		}
	}
	if req.Pinned != nil {
		record.Pinned = *req.Pinned
	}
	record.UpdatedAt = time.Now().UTC()
	if err := s.gdb.WithContext(ctx).Save(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "更新公告失败"})
		return
	}
	s.hub.Broadcast(ctx, ws.Event{
		Type: "announcement.updated",
		Payload: gin.H{
			"id": record.ID.String(), "title": record.Title, "contentHtml": record.ContentHTML,
			"contentText": record.ContentText, "pinned": record.Pinned, "updatedAt": record.UpdatedAt,
		},
	})
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": record.ID.String(), "updatedAt": record.UpdatedAt})
}

func (s *Server) handleDeleteAnnouncement(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的公告 ID"})
		return
	}
	ctx := c.Request.Context()
	res := s.gdb.WithContext(ctx).Delete(&db.Announcement{}, "id = ?", id)
	if res.Error != nil || res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "公告不存在或已删除"})
		return
	}
	s.hub.Broadcast(ctx, ws.Event{Type: "announcement.deleted", Payload: gin.H{"id": id.String()}})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleMarkAnnouncementRead(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的公告 ID"})
		return
	}
	ctx := c.Request.Context()
	now := time.Now().UTC()
	if err := s.gdb.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&db.AnnouncementReceipt{
			AnnouncementID: id,
			UserID:         user.UserID,
			ReadAt:         now,
		}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "写入已读回执失败"})
		return
	}

	var readCount int64
	_ = s.gdb.WithContext(ctx).
		Table("announcement_receipts r").
		Joins("JOIN orbit_members m ON m.user_id = r.user_id AND m.is_active = TRUE").
		Where("r.announcement_id = ?", id).
		Count(&readCount).Error
	total := s.activeMemberCount(ctx)
	if int(readCount) > total {
		total = int(readCount)
	}

	payload := gin.H{
		"announcementId": id.String(),
		"userId":         user.UserID,
		"displayName":    user.DisplayName,
		"avatar":         user.Avatar,
		"readAt":         now,
		"readCount":      int(readCount),
		"totalCount":     total,
	}
	s.hub.Broadcast(ctx, ws.Event{Type: "announcement.receipt", Payload: payload})
	c.JSON(http.StatusOK, payload)
}

type receiptMemberDTO struct {
	UserID      string     `json:"userId"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	Avatar      string     `json:"avatar"`
	IsCaptain   bool       `json:"isCaptain"`
	ReadAt      *time.Time `json:"readAt,omitempty"`
}

func (s *Server) handleGetAnnouncementReceipts(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的公告 ID"})
		return
	}
	ctx := c.Request.Context()
	var rows []receiptMemberDTO
	err = s.gdb.WithContext(ctx).Raw(`
		SELECT m.user_id, m.username, m.display_name, m.avatar, m.is_captain, r.read_at
		FROM orbit_members m
		LEFT JOIN announcement_receipts r
		  ON r.user_id = m.user_id AND r.announcement_id = ?
		WHERE m.is_active = TRUE
		ORDER BY (r.read_at IS NULL) ASC, r.read_at ASC, m.display_name ASC
	`, id).Scan(&rows).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询已读清单失败"})
		return
	}

	readList := make([]receiptMemberDTO, 0, len(rows))
	unreadList := make([]receiptMemberDTO, 0, len(rows))
	for _, m := range rows {
		if m.ReadAt != nil {
			readList = append(readList, m)
		} else {
			unreadList = append(unreadList, m)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"announcementId": id.String(),
		"readCount":      len(readList),
		"unreadCount":    len(unreadList),
		"totalCount":     len(readList) + len(unreadList),
		"read":           readList,
		"unread":         unreadList,
	})
}

func (s *Server) handleRemindUnread(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的公告 ID"})
		return
	}
	ctx := c.Request.Context()
	var ann db.Announcement
	if err := s.gdb.WithContext(ctx).Select("id", "title").First(&ann, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "公告不存在"})
		return
	}

	var unreadIDs []string
	err = s.gdb.WithContext(ctx).Raw(`
		SELECT m.user_id
		FROM orbit_members m
		WHERE m.is_active = TRUE
		  AND NOT EXISTS (
			SELECT 1 FROM announcement_receipts r
			WHERE r.announcement_id = ? AND r.user_id = m.user_id
		  )
	`, id).Scan(&unreadIDs).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询未读成员失败"})
		return
	}

	reminded := 0
	for _, targetID := range unreadIDs {
		uid := targetID
		notif, err := s.insertNotification(ctx, createNotifInput{
			SourceApp:    "orbit",
			EventType:    "announcement.remind",
			Title:        "队长提醒查阅公告",
			Body:         fmt.Sprintf("%s 提醒你阅读公告《%s》", user.DisplayName, ann.Title),
			Payload:      map[string]any{"announcementId": id.String(), "title": ann.Title},
			TargetUserID: &uid,
		})
		if err == nil {
			s.hub.PushToUser(ctx, uid, ws.Event{Type: "notification.created", Payload: notif})
			reminded++
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "remindedCount": reminded})
}

func (s *Server) handleUploadImage(c *gin.Context) {
	if s.uploader == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "RustFS 对象存储尚未配置"})
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请上传图片文件（字段名 file）"})
		return
	}
	if fh.Size > 10*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "单张图片不能超过 10MB"})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无法读取上传文件"})
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 10*1024*1024+1))
	if err != nil || len(data) > 10*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "图片体积超限"})
		return
	}
	contentType := http.DetectContentType(data)
	allowed := map[string]string{
		"image/png":  ".png",
		"image/jpeg": ".jpg",
		"image/webp": ".webp",
		"image/gif":  ".gif",
	}
	ext, ok := allowed[contentType]
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "仅支持 PNG / JPG / WEBP / GIF 图片"})
		return
	}
	now := time.Now().UTC()
	relKey := filepath.ToSlash(fmt.Sprintf("announcements/%04d/%02d/%s%s", now.Year(), now.Month(), uuid.NewString(), ext))
	url, err := s.uploader.PutPublicObject(c.Request.Context(), relKey, data, contentType)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"url": url})
}

type notificationDTO struct {
	ID           string          `json:"id"`
	SourceApp    string          `json:"sourceApp"`
	EventType    string          `json:"eventType"`
	Title        string          `json:"title"`
	Body         string          `json:"body"`
	Payload      json.RawMessage `json:"payload"`
	TargetUserID *string         `json:"targetUserId,omitempty"`
	ActionStatus *string         `json:"actionStatus,omitempty"`
	ActionNote   *string         `json:"actionNote,omitempty"`
	ActionBy     *string         `json:"actionBy,omitempty"`
	ActionAt     *time.Time      `json:"actionAt,omitempty"`
	IsRead       bool            `json:"isRead"`
	CreatedAt    time.Time       `json:"createdAt"`
}

type createNotifInput struct {
	SourceApp    string
	EventType    string
	Title        string
	Body         string
	Payload      any
	TargetUserID *string
	ActionStatus *string
}

func (s *Server) insertNotification(ctx context.Context, in createNotifInput) (notificationDTO, error) {
	id := uuid.New()
	now := time.Now().UTC()
	rawPayload, err := json.Marshal(in.Payload)
	if err != nil || len(rawPayload) == 0 || string(rawPayload) == "null" {
		rawPayload = []byte("{}")
	}
	record := db.Notification{
		ID:           id,
		SourceApp:    in.SourceApp,
		EventType:    in.EventType,
		Title:        in.Title,
		Body:         in.Body,
		Payload:      string(rawPayload),
		TargetUserID: in.TargetUserID,
		ActionStatus: in.ActionStatus,
		CreatedAt:    now,
	}
	if err := s.gdb.WithContext(ctx).Create(&record).Error; err != nil {
		return notificationDTO{}, err
	}
	return notificationDTO{
		ID:           id.String(),
		SourceApp:    in.SourceApp,
		EventType:    in.EventType,
		Title:        in.Title,
		Body:         in.Body,
		Payload:      rawPayload,
		TargetUserID: in.TargetUserID,
		ActionStatus: in.ActionStatus,
		IsRead:       false,
		CreatedAt:    now,
	}, nil
}

func (s *Server) handleListNotifications(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	sourceApp := strings.TrimSpace(c.Query("sourceApp"))
	unreadOnly := c.Query("unreadOnly") == "true"

	type rowResult struct {
		ID           string
		SourceApp    string
		EventType    string
		Title        string
		Body         string
		Payload      string
		TargetUserID *string
		ActionStatus *string
		ActionNote   *string
		ActionBy     *string
		ActionAt     *time.Time
		IsRead       bool
		CreatedAt    time.Time
	}
	var rows []rowResult
	err := s.gdb.WithContext(c.Request.Context()).Raw(`
		SELECT n.id::text AS id, n.source_app, n.event_type, n.title, n.body, n.payload::text AS payload,
		       n.target_user_id, n.action_status, n.action_note, n.action_by, n.action_at,
		       EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS is_read,
		       n.created_at
		FROM notifications n
		WHERE (n.target_user_id IS NULL OR n.target_user_id = ?)
		  AND (? = '' OR n.source_app = ?)
		  AND (NOT ? OR NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?))
		ORDER BY n.created_at DESC
		LIMIT 80
	`, user.UserID, user.UserID, sourceApp, sourceApp, unreadOnly, user.UserID).Scan(&rows).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询通知失败"})
		return
	}

	items := make([]notificationDTO, 0, len(rows))
	for _, r := range rows {
		raw := json.RawMessage(r.Payload)
		if len(raw) == 0 {
			raw = json.RawMessage("{}")
		}
		items = append(items, notificationDTO{
			ID:           r.ID,
			SourceApp:    r.SourceApp,
			EventType:    r.EventType,
			Title:        r.Title,
			Body:         r.Body,
			Payload:      raw,
			TargetUserID: r.TargetUserID,
			ActionStatus: r.ActionStatus,
			ActionNote:   r.ActionNote,
			ActionBy:     r.ActionBy,
			ActionAt:     r.ActionAt,
			IsRead:       r.IsRead,
			CreatedAt:    r.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (s *Server) handleMarkNotificationRead(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的通知 ID"})
		return
	}
	if err := s.gdb.WithContext(c.Request.Context()).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&db.NotificationRead{
			NotificationID: id,
			UserID:         user.UserID,
			ReadAt:         time.Now().UTC(),
		}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "标记已读失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleMarkAllNotificationsRead(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	err := s.gdb.WithContext(c.Request.Context()).Exec(`
		INSERT INTO notification_reads (notification_id, user_id, read_at)
		SELECT n.id, ?, NOW()
		FROM notifications n
		WHERE (n.target_user_id IS NULL OR n.target_user_id = ?)
		ON CONFLICT DO NOTHING
	`, user.UserID, user.UserID).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "批量已读失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleCreateDocEditRequest(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	var req struct {
		PageKey string `json:"pageKey" binding:"required"`
		Reason  string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请提供文档标识"})
		return
	}
	ctx := c.Request.Context()
	meta, err := s.docClient.ResolvePageMeta(ctx, req.PageKey, user.UserID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if meta.RequesterCanEdit {
		c.JSON(http.StatusBadRequest, gin.H{"error": "你已拥有该文档的编辑权限，无需重复申请"})
		return
	}
	if meta.CreatorSsoSub == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "未找到该文档作者的 LecSSO 账号，无法推送审批"})
		return
	}
	if meta.CreatorSsoSub == user.UserID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "你是该文档的作者，默认拥有完整编辑权"})
		return
	}

	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "申请协作编辑该文档"
	}
	pending := "pending"
	authorID := meta.CreatorSsoSub
	notif, err := s.insertNotification(ctx, createNotifInput{
		SourceApp: "lec-doc",
		EventType: "doc.edit_request",
		Title:     fmt.Sprintf("文档编辑权限申请：《%s》", meta.Title),
		Body:      fmt.Sprintf("%s 申请编辑你的云文档《%s》，理由：%s", user.DisplayName, meta.Title, reason),
		Payload: map[string]any{
			"pageId":          meta.PageID,
			"pageSlugId":      meta.SlugID,
			"pageTitle":       meta.Title,
			"pageUrl":         meta.PageURL,
			"requesterId":     user.UserID,
			"requesterName":   user.DisplayName,
			"requesterAvatar": user.Avatar,
			"reason":          reason,
		},
		TargetUserID: &authorID,
		ActionStatus: &pending,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建审批通知失败"})
		return
	}
	s.hub.PushToUser(ctx, authorID, ws.Event{Type: "notification.created", Payload: notif})
	c.JSON(http.StatusCreated, gin.H{
		"ok":          true,
		"requestId":   notif.ID,
		"pageTitle":   meta.Title,
		"authorName":  meta.CreatorName,
		"description": fmt.Sprintf("已向作者 %s 发送 Orbit 实时审批卡片", meta.CreatorName),
	})
}

// handleInternalDocEditRequest 供 LecDoc Web 端转发成员发起的编辑权限申请，直接向作者的 Orbit 推送审批卡片。
func (s *Server) handleInternalDocEditRequest(c *gin.Context) {
	var req struct {
		PageID          string `json:"pageId" binding:"required"`
		PageSlugID      string `json:"pageSlugId"`
		PageTitle       string `json:"pageTitle" binding:"required"`
		PageURL         string `json:"pageUrl"`
		AuthorSsoSub    string `json:"authorSsoSub" binding:"required"`
		AuthorName      string `json:"authorName"`
		RequesterSsoSub string `json:"requesterSsoSub" binding:"required"`
		RequesterName   string `json:"requesterName" binding:"required"`
		RequesterAvatar string `json:"requesterAvatar"`
		Reason          string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少必要的文档编辑申请参数"})
		return
	}
	if req.AuthorSsoSub == req.RequesterSsoSub {
		c.JSON(http.StatusBadRequest, gin.H{"error": "你是该文档的作者，默认拥有完整编辑权"})
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "申请协作编辑该文档"
	}
	pending := "pending"
	authorID := strings.TrimSpace(req.AuthorSsoSub)
	ctx := c.Request.Context()
	notif, err := s.insertNotification(ctx, createNotifInput{
		SourceApp: "lec-doc",
		EventType: "doc.edit_request",
		Title:     fmt.Sprintf("文档编辑权限申请：《%s》", req.PageTitle),
		Body:      fmt.Sprintf("%s 申请编辑你的云文档《%s》，理由：%s", req.RequesterName, req.PageTitle, reason),
		Payload: map[string]any{
			"pageId":          req.PageID,
			"pageSlugId":      req.PageSlugID,
			"pageTitle":       req.PageTitle,
			"pageUrl":         req.PageURL,
			"requesterId":     req.RequesterSsoSub,
			"requesterName":   req.RequesterName,
			"requesterAvatar": req.RequesterAvatar,
			"reason":          reason,
		},
		TargetUserID: &authorID,
		ActionStatus: &pending,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建审批通知失败"})
		return
	}
	s.hub.PushToUser(ctx, authorID, ws.Event{Type: "notification.created", Payload: notif})
	authorLabel := strings.TrimSpace(req.AuthorName)
	if authorLabel == "" {
		authorLabel = "文档作者"
	}
	c.JSON(http.StatusCreated, gin.H{
		"ok":          true,
		"requestId":   notif.ID,
		"pageTitle":   req.PageTitle,
		"authorName":  authorLabel,
		"description": fmt.Sprintf("已向作者 %s 发送 Orbit 实时审批卡片", authorLabel),
	})
}

func (s *Server) handleNotificationAction(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的通知 ID"})
		return
	}
	var req struct {
		Decision string `json:"decision" binding:"required"`
		Note     string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请指定 decision（approve / deny）"})
		return
	}
	decision := strings.ToLower(strings.TrimSpace(req.Decision))
	if decision != "approve" && decision != "deny" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "decision 仅支持 approve 或 deny"})
		return
	}

	ctx := c.Request.Context()
	var record db.Notification
	if err := s.gdb.WithContext(ctx).First(&record, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "通知不存在"})
		return
	}
	if record.TargetUserID == nil || *record.TargetUserID != user.UserID {
		c.JSON(http.StatusForbidden, gin.H{"error": "仅被通知的审批人可处理该请求"})
		return
	}
	if record.ActionStatus == nil || *record.ActionStatus != "pending" {
		c.JSON(http.StatusConflict, gin.H{"error": "该申请已处理，无需重复操作"})
		return
	}

	var payload map[string]any
	_ = json.Unmarshal([]byte(record.Payload), &payload)
	pageID, _ := payload["pageId"].(string)
	pageTitle, _ := payload["pageTitle"].(string)
	pageURL, _ := payload["pageUrl"].(string)
	requesterID, _ := payload["requesterId"].(string)

	if record.EventType == "doc.edit_request" && decision == "approve" {
		if err := s.docClient.GrantEditorAccess(ctx, pageID, requesterID, user.UserID); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
	}

	nextStatus := "approved"
	if decision == "deny" {
		nextStatus = "denied"
	}
	now := time.Now().UTC()
	note := strings.TrimSpace(req.Note)
	if err := s.gdb.WithContext(ctx).Model(&record).Updates(map[string]any{
		"action_status": nextStatus,
		"action_note":   note,
		"action_by":     user.UserID,
		"action_at":     now,
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "保存审批结果失败"})
		return
	}
	_ = s.gdb.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&db.NotificationRead{
			NotificationID: id,
			UserID:         user.UserID,
			ReadAt:         now,
		}).Error

	s.hub.PushToUser(ctx, user.UserID, ws.Event{
		Type: "notification.updated",
		Payload: gin.H{
			"id": id.String(), "actionStatus": nextStatus, "actionNote": note,
			"actionBy": user.UserID, "actionAt": now, "isRead": true,
		},
	})

	if requesterID != "" {
		resultTitle := fmt.Sprintf("编辑权限申请已通过：《%s》", pageTitle)
		resultBody := fmt.Sprintf("作者 %s 已同意你的编辑申请，现在可以直接编辑该文档。", user.DisplayName)
		if decision == "deny" {
			resultTitle = fmt.Sprintf("编辑权限申请未通过：《%s》", pageTitle)
			resultBody = fmt.Sprintf("作者 %s 拒绝了你的编辑申请%s", user.DisplayName, func() string {
				if note != "" {
					return "，说明：" + note
				}
				return "。"
			}())
		}
		resNotif, err := s.insertNotification(ctx, createNotifInput{
			SourceApp:    "lec-doc",
			EventType:    "doc.edit_request_result",
			Title:        resultTitle,
			Body:         resultBody,
			Payload:      map[string]any{"pageId": pageID, "pageTitle": pageTitle, "pageUrl": pageURL, "decision": nextStatus},
			TargetUserID: &requesterID,
		})
		if err == nil {
			s.hub.PushToUser(ctx, requesterID, ws.Event{Type: "notification.created", Payload: resNotif})
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id.String(), "actionStatus": nextStatus})
}

func (s *Server) handleInternalEvent(c *gin.Context) {
	var req struct {
		SourceApp    string         `json:"sourceApp" binding:"required"`
		EventType    string         `json:"eventType" binding:"required"`
		Title        string         `json:"title" binding:"required"`
		Body         string         `json:"body"`
		Payload      map[string]any `json:"payload"`
		TargetUserID *string        `json:"targetUserId"`
		ActionStatus *string        `json:"actionStatus"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "事件格式无效"})
		return
	}
	ctx := c.Request.Context()
	notif, err := s.insertNotification(ctx, createNotifInput{
		SourceApp:    strings.TrimSpace(req.SourceApp),
		EventType:    strings.TrimSpace(req.EventType),
		Title:        strings.TrimSpace(req.Title),
		Body:         strings.TrimSpace(req.Body),
		Payload:      req.Payload,
		TargetUserID: req.TargetUserID,
		ActionStatus: req.ActionStatus,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "写入事件失败"})
		return
	}
	if req.TargetUserID != nil && *req.TargetUserID != "" {
		s.hub.PushToUser(ctx, *req.TargetUserID, ws.Event{Type: "notification.created", Payload: notif})
	} else {
		s.hub.Broadcast(ctx, ws.Event{Type: "notification.created", Payload: notif})
	}
	c.JSON(http.StatusCreated, notif)
}

func (s *Server) handleDevtronWebhook(c *gin.Context) {
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Webhook 负载无效"})
		return
	}
	appName, _ := raw["appName"].(string)
	if appName == "" {
		if p, ok := raw["payload"].(map[string]any); ok {
			appName, _ = p["appName"].(string)
		}
	}
	if appName == "" {
		appName = "studio-app"
	}
	version, _ := raw["version"].(string)
	summary, _ := raw["summary"].(string)
	if summary == "" {
		summary, _ = raw["message"].(string)
	}
	if summary == "" {
		summary = fmt.Sprintf("%s 已完成新一轮校园生产环境发布上线。", appName)
	}
	title := fmt.Sprintf("%s 已发布更新", appName)
	if version != "" {
		title = fmt.Sprintf("%s 已更新至 %s", appName, version)
	}
	ctx := c.Request.Context()
	notif, err := s.insertNotification(ctx, createNotifInput{
		SourceApp: appName,
		EventType: "app.updated",
		Title:     title,
		Body:      summary,
		Payload:   raw,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "广播更新通知失败"})
		return
	}
	s.hub.Broadcast(ctx, ws.Event{Type: "notification.created", Payload: notif})
	c.JSON(http.StatusCreated, notif)
}
