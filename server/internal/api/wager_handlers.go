package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/db"
)

const (
	wagerAssetOrbitPoints  = "orbit_points"
	wagerAssetPunchMinutes = "punch_minutes"

	wagerMaxPointsPerMatch       = 50
	wagerMaxPunchMinutesPerMatch = 60
	wagerDefaultPointsBalance    = 500
	wagerTicketTTL               = 2 * time.Hour
	wagerSignatureMaxSkew        = 5 * time.Minute
)

type wagerTicketDTO struct {
	WagerID        string `json:"wagerId"`
	AppID          string `json:"appId"`
	MatchID        string `json:"matchId"`
	Title          string `json:"title"`
	Asset          string `json:"asset"`
	Amount         int    `json:"amount"`
	Status         string `json:"status"`
	CreatorUserID  string `json:"creatorUserId"`
	OpponentUserID string `json:"opponentUserId,omitempty"`
	WinnerUserID   string `json:"winnerUserId,omitempty"`
	LoserUserID    string `json:"loserUserId,omitempty"`
	ExpiresAt      int64  `json:"expiresAt"`
}

func toWagerTicketDTO(w db.MiniAppWager) wagerTicketDTO {
	dto := wagerTicketDTO{
		WagerID:        w.ID.String(),
		AppID:          w.AppID,
		MatchID:        w.MatchID,
		Title:          w.Title,
		Asset:          w.Asset,
		Amount:         w.Amount,
		Status:         w.Status,
		CreatorUserID:  w.CreatorUserID,
		OpponentUserID: w.OpponentUserID,
		ExpiresAt:      w.ExpiresAt.UnixMilli(),
	}
	if w.WinnerUserID != nil {
		dto.WinnerUserID = *w.WinnerUserID
	}
	if w.LoserUserID != nil {
		dto.LoserUserID = *w.LoserUserID
	}
	return dto
}

// VerifyWagerHMACSignature 校验小程序权威后端发来的 S2S 结算请求 HMAC-SHA256 签名。
func VerifyWagerHMACSignature(secret, timestampStr string, rawBody []byte, sigHeader string, now time.Time) bool {
	if secret == "" || timestampStr == "" || sigHeader == "" {
		return false
	}
	tsMs, err := strconv.ParseInt(strings.TrimSpace(timestampStr), 10, 64)
	if err != nil {
		return false
	}
	skew := now.Sub(time.UnixMilli(tsMs))
	if skew < 0 {
		skew = -skew
	}
	if skew > wagerSignatureMaxSkew {
		return false
	}
	gotHex := strings.TrimPrefix(strings.TrimSpace(sigHeader), "sha256=")
	if gotHex == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.TrimSpace(timestampStr)))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(rawBody)
	expectedHex := hex.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(strings.ToLower(gotHex)), []byte(expectedHex)) == 1
}

func ensureWalletTx(tx *gorm.DB, userID string, now time.Time) (*db.MemberWagerWallet, error) {
	var wallet db.MemberWagerWallet
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ?", userID).
		First(&wallet).Error
	if err == nil {
		return &wallet, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	wallet = db.MemberWagerWallet{
		UserID:        userID,
		PointsBalance: wagerDefaultPointsBalance,
		UpdatedAt:     now,
	}
	if err := tx.Create(&wallet).Error; err != nil {
		return nil, err
	}
	return &wallet, nil
}

func (s *Server) handleGetWagerSummary(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	now := time.Now()
	var wallet db.MemberWagerWallet
	err := s.gdb.WithContext(c.Request.Context()).
		Transaction(func(tx *gorm.DB) error {
			w, err := ensureWalletTx(tx, user.UserID, now)
			if err != nil {
				return err
			}
			wallet = *w
			return nil
		})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取成员赌约账户失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"points":                  wallet.PointsBalance,
		"weeklyPunchMinutes":      wallet.WeeklyPunchMinutes,
		"pendingPunchDebtMinutes": wallet.PendingPunchDebtMinutes,
	})
}

func (s *Server) handleCreateMiniAppWager(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	if appID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少应用 ID"})
		return
	}

	var req struct {
		Asset          string `json:"asset"`
		Amount         int    `json:"amount"`
		MatchID        string `json:"matchId"`
		OpponentUserID string `json:"opponentUserId"`
		Title          string `json:"title"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "赌约请求参数无效"})
		return
	}

	req.Asset = strings.TrimSpace(req.Asset)
	req.MatchID = strings.TrimSpace(req.MatchID)
	req.Title = strings.TrimSpace(req.Title)
	req.OpponentUserID = strings.TrimSpace(req.OpponentUserID)

	if req.MatchID == "" || len(req.MatchID) > 64 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "对局标识 matchId 无效"})
		return
	}
	if req.Title == "" {
		req.Title = appID
	}
	if req.Amount < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "赌约数额必须大于 0"})
		return
	}
	switch req.Asset {
	case wagerAssetOrbitPoints:
		if req.Amount > wagerMaxPointsPerMatch {
			c.JSON(http.StatusBadRequest, gin.H{"error": "单局 Orbit 积分赌约不能超过 50"})
			return
		}
	case wagerAssetPunchMinutes:
		if req.Amount > wagerMaxPunchMinutesPerMatch {
			c.JSON(http.StatusBadRequest, gin.H{"error": "单局加时打卡赌约不能超过 60 分钟"})
			return
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的赌约资产类型"})
		return
	}

	now := time.Now()
	wager := db.MiniAppWager{
		ID:             uuid.New(),
		AppID:          appID,
		MatchID:        req.MatchID,
		Title:          req.Title,
		Asset:          req.Asset,
		Amount:         req.Amount,
		Status:         "pending_accept",
		CreatorUserID:  user.UserID,
		OpponentUserID: req.OpponentUserID,
		ExpiresAt:      now.Add(wagerTicketTTL),
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	err := s.gdb.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if wager.Asset == wagerAssetOrbitPoints {
			wallet, err := ensureWalletTx(tx, user.UserID, now)
			if err != nil {
				return err
			}
			if wallet.PointsBalance < wager.Amount {
				return errors.New("INSUFFICIENT_POINTS")
			}
			wallet.PointsBalance -= wager.Amount
			wallet.FrozenPoints += wager.Amount
			wallet.UpdatedAt = now
			if err := tx.Save(wallet).Error; err != nil {
				return err
			}
		}
		return tx.Create(&wager).Error
	})
	if err != nil {
		if err.Error() == "INSUFFICIENT_POINTS" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "当前可用 Orbit 积分不足"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建赌约托管单失败"})
		return
	}

	c.JSON(http.StatusCreated, toWagerTicketDTO(wager))
}

func (s *Server) handleGetMiniAppWager(c *gin.Context) {
	appID := strings.TrimSpace(c.Param("id"))
	wagerUUID, err := uuid.Parse(strings.TrimSpace(c.Param("wagerId")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的赌约 ID"})
		return
	}
	var wager db.MiniAppWager
	if err := s.gdb.WithContext(c.Request.Context()).
		Where("id = ? AND app_id = ?", wagerUUID, appID).
		First(&wager).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "赌约托管单不存在"})
		return
	}
	c.JSON(http.StatusOK, toWagerTicketDTO(wager))
}

func (s *Server) handleAcceptMiniAppWager(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	wagerUUID, err := uuid.Parse(strings.TrimSpace(c.Param("wagerId")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的赌约 ID"})
		return
	}

	now := time.Now()
	var updated db.MiniAppWager
	err = s.gdb.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		var wager db.MiniAppWager
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND app_id = ?", wagerUUID, appID).
			First(&wager).Error; err != nil {
			return err
		}
		if wager.Status != "pending_accept" {
			return errors.New("INVALID_STATUS")
		}
		if now.After(wager.ExpiresAt) {
			return errors.New("EXPIRED")
		}
		if wager.CreatorUserID == user.UserID {
			return errors.New("SELF_ACCEPT")
		}
		if wager.OpponentUserID != "" && wager.OpponentUserID != user.UserID {
			return errors.New("OPPONENT_MISMATCH")
		}
		if wager.Asset == wagerAssetOrbitPoints {
			wallet, err := ensureWalletTx(tx, user.UserID, now)
			if err != nil {
				return err
			}
			if wallet.PointsBalance < wager.Amount {
				return errors.New("INSUFFICIENT_POINTS")
			}
			wallet.PointsBalance -= wager.Amount
			wallet.FrozenPoints += wager.Amount
			wallet.UpdatedAt = now
			if err := tx.Save(wallet).Error; err != nil {
				return err
			}
		}
		wager.OpponentUserID = user.UserID
		wager.Status = "locked"
		wager.UpdatedAt = now
		if err := tx.Save(&wager).Error; err != nil {
			return err
		}
		updated = wager
		return nil
	})
	if err != nil {
		switch err.Error() {
		case "INVALID_STATUS":
			c.JSON(http.StatusConflict, gin.H{"error": "该赌约已锁定或已结束"})
		case "EXPIRED":
			c.JSON(http.StatusGone, gin.H{"error": "该赌约已过期"})
		case "SELF_ACCEPT":
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能应战自己发起的赌约"})
		case "OPPONENT_MISMATCH":
			c.JSON(http.StatusForbidden, gin.H{"error": "你不是该赌约指定的应战成员"})
		case "INSUFFICIENT_POINTS":
			c.JSON(http.StatusBadRequest, gin.H{"error": "当前可用 Orbit 积分不足"})
		default:
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "赌约托管单不存在"})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "应战赌约失败"})
			}
		}
		return
	}

	c.JSON(http.StatusOK, toWagerTicketDTO(updated))
}

func (s *Server) handleCancelMiniAppWager(c *gin.Context) {
	user, _ := auth.CurrentUser(c)
	appID := strings.TrimSpace(c.Param("id"))
	wagerUUID, err := uuid.Parse(strings.TrimSpace(c.Param("wagerId")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的赌约 ID"})
		return
	}

	now := time.Now()
	err = s.gdb.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		var wager db.MiniAppWager
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND app_id = ?", wagerUUID, appID).
			First(&wager).Error; err != nil {
			return err
		}
		if wager.Status != "pending_accept" {
			return errors.New("INVALID_STATUS")
		}
		if wager.CreatorUserID != user.UserID && wager.OpponentUserID != user.UserID {
			return errors.New("FORBIDDEN")
		}
		if wager.Asset == wagerAssetOrbitPoints {
			wallet, err := ensureWalletTx(tx, wager.CreatorUserID, now)
			if err != nil {
				return err
			}
			refund := wager.Amount
			if wallet.FrozenPoints < refund {
				refund = wallet.FrozenPoints
			}
			wallet.FrozenPoints -= refund
			wallet.PointsBalance += refund
			wallet.UpdatedAt = now
			if err := tx.Save(wallet).Error; err != nil {
				return err
			}
		}
		wager.Status = "refunded"
		wager.UpdatedAt = now
		return tx.Save(&wager).Error
	})
	if err != nil {
		switch err.Error() {
		case "INVALID_STATUS":
			c.JSON(http.StatusConflict, gin.H{"error": "赌约已锁定，无法直接取消"})
		case "FORBIDDEN":
			c.JSON(http.StatusForbidden, gin.H{"error": "无权取消该赌约"})
		default:
			c.JSON(http.StatusNotFound, gin.H{"error": "赌约托管单不存在"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleSettleMiniAppWagerS2S(c *gin.Context) {
	if s.cfg.MiniAppWagerSecret == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "工坊赌约 S2S 密钥尚未配置"})
		return
	}
	rawBody, err := io.ReadAll(io.LimitReader(c.Request.Body, 64*1024))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "读取结算报文失败"})
		return
	}

	appID := strings.TrimSpace(c.GetHeader("X-Orbit-App-Id"))
	tsHeader := strings.TrimSpace(c.GetHeader("X-Orbit-Timestamp"))
	sigHeader := strings.TrimSpace(c.GetHeader("X-Orbit-Signature"))
	if appID == "" || !VerifyWagerHMACSignature(s.cfg.MiniAppWagerSecret, tsHeader, rawBody, sigHeader, time.Now()) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "S2S 签名校验失败"})
		return
	}

	wagerUUID, err := uuid.Parse(strings.TrimSpace(c.Param("wagerId")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的赌约 ID"})
		return
	}

	var req struct {
		MatchID      string `json:"matchId"`
		WinnerUserID string `json:"winnerUserId"`
		LoserUserID  string `json:"loserUserId"`
		Result       string `json:"result"` // win | draw | refund
		Summary      string `json:"summary"`
	}
	if err := json.Unmarshal(rawBody, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "结算 JSON 无效"})
		return
	}

	now := time.Now()
	var settled db.MiniAppWager
	err = s.gdb.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		var wager db.MiniAppWager
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND app_id = ?", wagerUUID, appID).
			First(&wager).Error; err != nil {
			return err
		}
		// 强幂等：已结算/已退还直接返回当前状态
		if wager.Status == "settled" || wager.Status == "refunded" {
			settled = wager
			return nil
		}
		if wager.Status != "locked" {
			return errors.New("NOT_LOCKED")
		}

		isDraw := req.Result == "draw" || req.Result == "refund" || req.WinnerUserID == "" || req.WinnerUserID == "draw"
		if isDraw {
			if wager.Asset == wagerAssetOrbitPoints {
				for _, uid := range []string{wager.CreatorUserID, wager.OpponentUserID} {
					if uid == "" {
						continue
					}
					wallet, err := ensureWalletTx(tx, uid, now)
					if err != nil {
						return err
					}
					refund := wager.Amount
					if wallet.FrozenPoints < refund {
						refund = wallet.FrozenPoints
					}
					wallet.FrozenPoints -= refund
					wallet.PointsBalance += refund
					wallet.UpdatedAt = now
					if err := tx.Save(wallet).Error; err != nil {
						return err
					}
				}
			}
			wager.Status = "refunded"
		} else {
			winnerID := strings.TrimSpace(req.WinnerUserID)
			if winnerID != wager.CreatorUserID && winnerID != wager.OpponentUserID {
				return errors.New("INVALID_WINNER")
			}
			loserID := wager.OpponentUserID
			if winnerID == wager.OpponentUserID {
				loserID = wager.CreatorUserID
			}

			if wager.Asset == wagerAssetOrbitPoints {
				winnerWallet, err := ensureWalletTx(tx, winnerID, now)
				if err != nil {
					return err
				}
				loserWallet, err := ensureWalletTx(tx, loserID, now)
				if err != nil {
					return err
				}
				if winnerWallet.FrozenPoints >= wager.Amount {
					winnerWallet.FrozenPoints -= wager.Amount
				}
				if loserWallet.FrozenPoints >= wager.Amount {
					loserWallet.FrozenPoints -= wager.Amount
				}
				winnerWallet.PointsBalance += wager.Amount * 2
				winnerWallet.UpdatedAt = now
				loserWallet.UpdatedAt = now
				if err := tx.Save(winnerWallet).Error; err != nil {
					return err
				}
				if err := tx.Save(loserWallet).Error; err != nil {
					return err
				}
			} else if wager.Asset == wagerAssetPunchMinutes {
				// 不篡改历史真实考勤记录，仅给败方追加加时打卡待核销分钟数
				loserWallet, err := ensureWalletTx(tx, loserID, now)
				if err != nil {
					return err
				}
				loserWallet.PendingPunchDebtMinutes += wager.Amount
				loserWallet.UpdatedAt = now
				if err := tx.Save(loserWallet).Error; err != nil {
					return err
				}
			}

			wager.WinnerUserID = &winnerID
			wager.LoserUserID = &loserID
			wager.Status = "settled"
		}

		wager.Summary = strings.TrimSpace(req.Summary)
		wager.SettledAt = &now
		wager.UpdatedAt = now
		if err := tx.Save(&wager).Error; err != nil {
			return err
		}
		settled = wager
		return nil
	})
	if err != nil {
		switch err.Error() {
		case "NOT_LOCKED":
			c.JSON(http.StatusConflict, gin.H{"error": "赌约尚未双方锁定，不能结算"})
		case "INVALID_WINNER":
			c.JSON(http.StatusBadRequest, gin.H{"error": "胜者必须是本局参与成员"})
		default:
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "赌约托管单不存在"})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "赌约结算失败"})
			}
		}
		return
	}

	c.JSON(http.StatusOK, toWagerTicketDTO(settled))
}
