package db

import (
	"context"
	"fmt"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func Connect(ctx context.Context, databaseURL string) (*gorm.DB, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL 未配置")
	}
	gdb, err := gorm.Open(postgres.Open(databaseURL), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, fmt.Errorf("连接 PostgreSQL（GORM）失败: %w", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, fmt.Errorf("获取底层 SQL 连接池失败: %w", err)
	}
	sqlDB.SetMaxOpenConns(16)
	sqlDB.SetMaxIdleConns(4)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(pingCtx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("PostgreSQL Ping 失败: %w", err)
	}

	if err := gdb.WithContext(ctx).AutoMigrate(
		&OrbitMember{},
		&Announcement{},
		&AnnouncementReceipt{},
		&Notification{},
		&NotificationRead{},
	); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("GORM AutoMigrate 失败: %w", err)
	}
	return gdb, nil
}
