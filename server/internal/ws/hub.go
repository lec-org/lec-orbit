package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
)

const redisChannel = "lec:orbit:ws:events"

// Event 表示实时推送给 Orbit 桌面端的 WebSocket 消息。
type Event struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

type envelope struct {
	TargetUserID string `json:"targetUserId,omitempty"`
	Event        Event  `json:"event"`
}

type clientConn struct {
	userID string
	send   chan []byte
}

// Hub 维护在线 WebSocket 连接，支持定向推送与全员广播，并可选经 Redis Pub/Sub 跨副本同步。
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*clientConn]struct{}
	rdb     *redis.Client
}

func NewHub(rdb *redis.Client) *Hub {
	return &Hub{
		clients: make(map[string]map[*clientConn]struct{}),
		rdb:     rdb,
	}
}

func (h *Hub) StartRedisSubscriber(ctx context.Context) {
	if h.rdb == nil {
		return
	}
	go func() {
		pubsub := h.rdb.Subscribe(ctx, redisChannel)
		defer pubsub.Close()
		ch := pubsub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var env envelope
				if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
					continue
				}
				h.deliverLocal(env)
			}
		}
	}()
}

func (h *Hub) Publish(ctx context.Context, targetUserID string, ev Event) {
	env := envelope{TargetUserID: targetUserID, Event: ev}
	if h.rdb != nil {
		raw, err := json.Marshal(env)
		if err == nil {
			if err := h.rdb.Publish(ctx, redisChannel, raw).Err(); err == nil {
				return
			}
		}
	}
	h.deliverLocal(env)
}

func (h *Hub) Broadcast(ctx context.Context, ev Event) {
	h.Publish(ctx, "", ev)
}

func (h *Hub) PushToUser(ctx context.Context, userID string, ev Event) {
	if userID == "" {
		return
	}
	h.Publish(ctx, userID, ev)
}

func (h *Hub) deliverLocal(env envelope) {
	raw, err := json.Marshal(env.Event)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	if env.TargetUserID != "" {
		for c := range h.clients[env.TargetUserID] {
			select {
			case c.send <- raw:
			default:
			}
		}
		return
	}
	for _, set := range h.clients {
		for c := range set {
			select {
			case c.send <- raw:
			default:
			}
		}
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request, userID string) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	c := &clientConn{
		userID: userID,
		send:   make(chan []byte, 64),
	}
	h.register(c)
	defer h.unregister(c)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// 写协程 + 30 秒心跳保活
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case data, ok := <-c.send:
				if !ok {
					return
				}
				writeCtx, wCancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(writeCtx, websocket.MessageText, data)
				wCancel()
				if err != nil {
					cancel()
					return
				}
			case <-ticker.C:
				pingCtx, pCancel := context.WithTimeout(ctx, 8*time.Second)
				err := conn.Ping(pingCtx)
				pCancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	// 读循环用于感知客户端断开
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("[ws] client %s disconnected: %v", userID, err)
			}
			return
		}
	}
}

func (h *Hub) register(c *clientConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[c.userID] == nil {
		h.clients[c.userID] = make(map[*clientConn]struct{})
	}
	h.clients[c.userID][c] = struct{}{}
}

func (h *Hub) unregister(c *clientConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.clients[c.userID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.clients, c.userID)
		}
	}
}
