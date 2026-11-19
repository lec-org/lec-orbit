package docbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lec-org/lec-orbit/server/internal/config"
)

// PageMeta 是 LecDoc 内部接口返回的页面作者与可编辑状态。
type PageMeta struct {
	PageID           string `json:"pageId"`
	SlugID           string `json:"slugId"`
	Title            string `json:"title"`
	Classification   string `json:"classification"`
	CreatorSsoSub    string `json:"creatorSsoSub"`
	CreatorName      string `json:"creatorName"`
	RequesterCanEdit bool   `json:"requesterCanEdit"`
	PageURL          string `json:"pageUrl"`
}

type Client struct {
	baseURL    string
	token      string
	publicURL  string
	httpClient *http.Client
}

func NewClient(cfg config.Config) *Client {
	return &Client{
		baseURL:    cfg.LecDocInternalURL,
		token:      cfg.LecDocInternalToken,
		publicURL:  cfg.LecDocPublicURL,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) Configured() bool {
	return c.baseURL != "" && c.token != ""
}

func (c *Client) ResolvePageMeta(ctx context.Context, slugOrID, requesterSsoSub string) (PageMeta, error) {
	if !c.Configured() {
		return PageMeta{}, fmt.Errorf("LecDoc 内部桥接未配置")
	}
	payload := map[string]string{
		"pageKey":         strings.TrimSpace(slugOrID),
		"requesterSsoSub": requesterSsoSub,
	}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/lec/pages/internal/orbit-page-meta", bytes.NewReader(raw))
	if err != nil {
		return PageMeta{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Orbit-Internal-Token", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return PageMeta{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 {
		return PageMeta{}, fmt.Errorf("查询云文档信息失败（HTTP %d）: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var wrap struct {
		Data *PageMeta `json:"data"`
	}
	if err := json.Unmarshal(body, &wrap); err == nil && wrap.Data != nil && wrap.Data.PageID != "" {
		return *wrap.Data, nil
	}
	var meta PageMeta
	if err := json.Unmarshal(body, &meta); err != nil {
		return PageMeta{}, err
	}
	return meta, nil
}

func (c *Client) GrantEditorAccess(ctx context.Context, pageID, requesterSsoSub, authorSsoSub string) error {
	if !c.Configured() {
		return fmt.Errorf("LecDoc 内部桥接未配置")
	}
	payload := map[string]string{
		"pageId":          pageID,
		"requesterSsoSub": requesterSsoSub,
		"authorSsoSub":    authorSsoSub,
	}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/lec/pages/internal/orbit-grant-editor", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Orbit-Internal-Token", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("云文档授予编辑权失败（HTTP %d）: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
