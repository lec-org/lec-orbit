package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/lec-org/lec-orbit/server/internal/api"
	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/config"
	"github.com/lec-org/lec-orbit/server/internal/db"
	"github.com/lec-org/lec-orbit/server/internal/docbridge"
	"github.com/lec-org/lec-orbit/server/internal/roster"
	"github.com/lec-org/lec-orbit/server/internal/storage"
	"github.com/lec-org/lec-orbit/server/internal/ws"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := config.Load()
	gdb, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[orbit-server] database init failed: %v", err)
	}
	if sqlDB, err := gdb.DB(); err == nil {
		defer sqlDB.Close()
	}

	var rdb *redis.Client
	if cfg.RedisURL != "" {
		opt, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			log.Fatalf("[orbit-server] parse REDIS_URL failed: %v", err)
		}
		rdb = redis.NewClient(opt)
		if err := rdb.Ping(ctx).Err(); err != nil {
			log.Printf("[orbit-server] redis ping warning (falling back to local hub): %v", err)
			_ = rdb.Close()
			rdb = nil
		} else {
			defer rdb.Close()
			log.Printf("[orbit-server] redis connected")
		}
	}

	hub := ws.NewHub(rdb)
	hub.StartRedisSubscriber(ctx)

	verifier := auth.NewVerifier(cfg)
	rosterSvc := roster.NewService(gdb, cfg)
	rosterSvc.StartPeriodicSync(ctx)

	uploader := storage.NewS3Uploader(cfg)
	docClient := docbridge.NewClient(cfg)

	srv := api.NewServer(cfg, gdb, verifier, rosterSvc, hub, uploader, docClient)
	httpSrv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[orbit-server] listening on :%s", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[orbit-server] listen failed: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("[orbit-server] shutting down gracefully...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[orbit-server] shutdown error: %v", err)
		os.Exit(1)
	}
}
