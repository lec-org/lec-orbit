package db

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// OrbitMember 工作室成员花名册缓存（同步自 LecSSO lec-studio 组织）。
type OrbitMember struct {
	UserID      string    `gorm:"column:user_id;primaryKey;type:text" json:"userId"`
	Username    string    `gorm:"column:username;type:text;not null;default:''" json:"username"`
	DisplayName string    `gorm:"column:display_name;type:text;not null;default:''" json:"displayName"`
	Avatar      string    `gorm:"column:avatar;type:text;not null;default:''" json:"avatar"`
	IsCaptain   bool      `gorm:"column:is_captain;not null;default:false" json:"isCaptain"`
	IsActive    bool      `gorm:"column:is_active;not null;default:true;index" json:"isActive"`
	UpdatedAt   time.Time `gorm:"column:updated_at;not null" json:"updatedAt"`
}

func (OrbitMember) TableName() string { return "orbit_members" }

// Announcement 队长发布的富文本公告。
type Announcement struct {
	ID           uuid.UUID      `gorm:"column:id;primaryKey;type:uuid"`
	Title        string         `gorm:"column:title;type:text;not null"`
	ContentHTML  string         `gorm:"column:content_html;type:text;not null"`
	ContentText  string         `gorm:"column:content_text;type:text;not null;default:''"`
	Pinned       bool           `gorm:"column:pinned;not null;default:false;index:idx_announcements_active_created,priority:1"`
	AuthorID     string         `gorm:"column:author_id;type:text;not null"`
	AuthorName   string         `gorm:"column:author_name;type:text;not null;default:''"`
	AuthorAvatar string         `gorm:"column:author_avatar;type:text;not null;default:''"`
	CreatedAt    time.Time      `gorm:"column:created_at;not null;index:idx_announcements_active_created,priority:2,sort:desc"`
	UpdatedAt    time.Time      `gorm:"column:updated_at;not null"`
	DeletedAt    gorm.DeletedAt `gorm:"column:deleted_at;index"`
}

func (Announcement) TableName() string { return "announcements" }

// AnnouncementReceipt 公告成员已读回执（联合主键确保幂等）。
type AnnouncementReceipt struct {
	AnnouncementID uuid.UUID `gorm:"column:announcement_id;primaryKey;type:uuid"`
	UserID         string    `gorm:"column:user_id;primaryKey;type:text;index:idx_announcement_receipts_user,priority:1"`
	ReadAt         time.Time `gorm:"column:read_at;not null;index:idx_announcement_receipts_user,priority:2,sort:desc"`
}

func (AnnouncementReceipt) TableName() string { return "announcement_receipts" }

// Notification 跨项目更新、云文档权限申请/审批与提醒等统一通知。
type Notification struct {
	ID           uuid.UUID  `gorm:"column:id;primaryKey;type:uuid"`
	SourceApp    string     `gorm:"column:source_app;type:text;not null;index"`
	EventType    string     `gorm:"column:event_type;type:text;not null"`
	Title        string     `gorm:"column:title;type:text;not null"`
	Body         string     `gorm:"column:body;type:text;not null;default:''"`
	Payload      string     `gorm:"column:payload;type:jsonb;not null;default:'{}'"`
	TargetUserID *string    `gorm:"column:target_user_id;type:text;index:idx_notifications_target_created,priority:1"`
	ActionStatus *string    `gorm:"column:action_status;type:text"`
	ActionNote   *string    `gorm:"column:action_note;type:text"`
	ActionBy     *string    `gorm:"column:action_by;type:text"`
	ActionAt     *time.Time `gorm:"column:action_at"`
	CreatedAt    time.Time  `gorm:"column:created_at;not null;index:idx_notifications_target_created,priority:2,sort:desc;index:idx_notifications_created,sort:desc"`
}

func (Notification) TableName() string { return "notifications" }

// NotificationRead 成员针对每条通知的已读记录。
type NotificationRead struct {
	NotificationID uuid.UUID `gorm:"column:notification_id;primaryKey;type:uuid"`
	UserID         string    `gorm:"column:user_id;primaryKey;type:text"`
	ReadAt         time.Time `gorm:"column:read_at;not null"`
}

func (NotificationRead) TableName() string { return "notification_reads" }

// MiniApp 工坊小程序与小游戏元数据主表（仅限 lec-studio 内部成员可见与发布）。
type MiniApp struct {
	ID              string     `gorm:"column:id;primaryKey;type:text"`
	Name            string     `gorm:"column:name;type:text;not null"`
	Type            string     `gorm:"column:type;type:text;not null;index"`
	Engine          string     `gorm:"column:engine;type:text;not null;index"`
	Description     string     `gorm:"column:description;type:text;not null;default:''"`
	IconURL         string     `gorm:"column:icon_url;type:text;not null;default:''"`
	TagsJSON        string     `gorm:"column:tags_json;type:jsonb;not null;default:'[]'"`
	OwnerID         string     `gorm:"column:owner_id;type:text;not null;index"`
	OwnerName       string     `gorm:"column:owner_name;type:text;not null;default:''"`
	OwnerAvatar     string     `gorm:"column:owner_avatar;type:text;not null;default:''"`
	Status          string     `gorm:"column:status;type:text;not null;default:'draft';index"`
	ActiveVersionID *uuid.UUID `gorm:"column:active_version_id;type:uuid"`
	FeaturedRank    int        `gorm:"column:featured_rank;not null;default:0"`
	PlayCount       int64      `gorm:"column:play_count;not null;default:0"`
	CreatedAt       time.Time  `gorm:"column:created_at;not null"`
	UpdatedAt       time.Time  `gorm:"column:updated_at;not null"`
}

func (MiniApp) TableName() string { return "mini_apps" }

// MiniAppVersion 工坊应用构建版本（支持 RustFS 直传 <=100MB 与 GitHub Releases 导入双源）。
type MiniAppVersion struct {
	ID           uuid.UUID  `gorm:"column:id;primaryKey;type:uuid"`
	AppID        string     `gorm:"column:app_id;type:text;not null;index:idx_mini_app_versions_app_created,priority:1"`
	Version      string     `gorm:"column:version;type:text;not null"`
	Channel      string     `gorm:"column:channel;type:text;not null;default:'preview'"`
	Status       string     `gorm:"column:status;type:text;not null;default:'pending';index"`
	SourceType   string     `gorm:"column:source_type;type:text;not null;default:'rustfs'"`
	BundleURL    string     `gorm:"column:bundle_url;type:text;not null"`
	BundleKey    string     `gorm:"column:bundle_key;type:text;not null;default:''"`
	BundleSHA256 string     `gorm:"column:bundle_sha256;type:text;not null"`
	BundleSize   int64      `gorm:"column:bundle_size;not null;default:0"`
	ManifestJSON string     `gorm:"column:manifest_json;type:jsonb;not null;default:'{}'"`
	Changelog    string     `gorm:"column:changelog;type:text;not null;default:''"`
	UploaderID   string     `gorm:"column:uploader_id;type:text;not null"`
	ReviewerID   *string    `gorm:"column:reviewer_id;type:text"`
	ReviewNote   *string    `gorm:"column:review_note;type:text"`
	CreatedAt    time.Time  `gorm:"column:created_at;not null;index:idx_mini_app_versions_app_created,priority:2,sort:desc"`
	ReviewedAt   *time.Time `gorm:"column:reviewed_at"`
}

func (MiniAppVersion) TableName() string { return "mini_app_versions" }

// MiniAppKV 工坊应用用户云存档（按 app_id + user_id 隔离，免自建后端）。
type MiniAppKV struct {
	AppID     string    `gorm:"column:app_id;primaryKey;type:text"`
	UserID    string    `gorm:"column:user_id;primaryKey;type:text"`
	Key       string    `gorm:"column:key;primaryKey;type:text"`
	ValueJSON string    `gorm:"column:value_json;type:jsonb;not null;default:'null'"`
	SizeBytes int       `gorm:"column:size_bytes;not null;default:0"`
	UpdatedAt time.Time `gorm:"column:updated_at;not null"`
}

func (MiniAppKV) TableName() string { return "mini_app_kv" }
