package miniapp

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
)

const (
	MaxBundleBytes       int64 = 100 * 1024 * 1024 // 默认 RustFS 单包上限 100MB
	MaxUncompressedBytes int64 = 250 * 1024 * 1024 // 防 Zip Bomb 解压上限 250MB
	MaxFileCount               = 5000
	MaxIconBytes         int64 = 2 * 1024 * 1024
)

var (
	appIDPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`)
	semverPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)
	validTypes    = map[string]bool{"miniapp": true, "minigame": true}
	validEngines  = map[string]bool{"web": true, "cocos": true, "unity": true, "godot": true, "other": true}
	validModes    = map[string]bool{"sidepanel": true, "workspace": true, "standalone": true}
	validScopes   = map[string]bool{"user.profile": true, "storage.cloud": true, "clipboard": true}
)

type WindowConfig struct {
	DefaultMode     string   `json:"defaultMode"`
	SupportedModes  []string `json:"supportedModes"`
	SidepanelWidth  int      `json:"sidepanelWidth"`
	Width           int      `json:"width"`
	Height          int      `json:"height"`
	Resizable       bool     `json:"resizable"`
	AspectRatio     string   `json:"aspectRatio,omitempty"`
	AllowFullscreen bool     `json:"allowFullscreen"`
}

type RuntimeConfig struct {
	CrossOriginIsolated bool   `json:"crossOriginIsolated"`
	IsolationPolicy     string `json:"isolationPolicy"`
	PointerLock         bool   `json:"pointerLock"`
	Gamepad             bool   `json:"gamepad"`
	MinOrbitVersion     string `json:"minOrbitVersion,omitempty"`
}

type PermissionsConfig struct {
	Scopes         []string `json:"scopes"`
	NetworkDomains []string `json:"networkDomains"`
}

type Manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Version       string            `json:"version"`
	Type          string            `json:"type"`
	Engine        string            `json:"engine"`
	Entry         string            `json:"entry"`
	Icon          string            `json:"icon,omitempty"`
	Description   string            `json:"description"`
	Tags          []string          `json:"tags"`
	Window        WindowConfig      `json:"window"`
	Runtime       RuntimeConfig     `json:"runtime"`
	Permissions   PermissionsConfig `json:"permissions"`
}

type ValidatedBundle struct {
	Manifest          Manifest
	ManifestJSON      string
	SHA256            string
	CompressedBytes   int64
	UncompressedBytes int64
	FileCount         int
	IconBytes         []byte
	IconContentType   string
	IconExt           string
}

func NormalizeAndValidateManifest(m *Manifest) error {
	if m.SchemaVersion == 0 {
		m.SchemaVersion = 1
	}
	if m.SchemaVersion != 1 {
		return fmt.Errorf("不支持的 manifest schemaVersion: %d", m.SchemaVersion)
	}
	m.ID = strings.TrimSpace(m.ID)
	if !appIDPattern.MatchString(m.ID) {
		return fmt.Errorf("应用 ID 非法（需为 2~64 位小写字母、数字与短横线）")
	}
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" || len([]rune(m.Name)) > 48 {
		return fmt.Errorf("应用名称不能为空且不超过 48 字")
	}
	m.Version = strings.TrimSpace(m.Version)
	if !semverPattern.MatchString(m.Version) {
		return fmt.Errorf("版本号需符合 SemVer（如 1.0.0）")
	}
	if m.Type == "" {
		m.Type = "miniapp"
	}
	if !validTypes[m.Type] {
		return fmt.Errorf("应用类型仅支持 miniapp 或 minigame")
	}
	if m.Engine == "" {
		m.Engine = "web"
	}
	if !validEngines[m.Engine] {
		return fmt.Errorf("引擎类型不支持：%s", m.Engine)
	}
	m.Entry = strings.TrimPrefix(strings.TrimSpace(m.Entry), "./")
	if m.Entry == "" {
		m.Entry = "index.html"
	}
	if strings.HasPrefix(m.Entry, "/") || strings.Contains(m.Entry, "..") {
		return fmt.Errorf("入口文件路径非法：%s", m.Entry)
	}
	if m.Icon != "" {
		m.Icon = strings.TrimPrefix(strings.TrimSpace(m.Icon), "./")
		if strings.HasPrefix(m.Icon, "/") || strings.Contains(m.Icon, "..") {
			return fmt.Errorf("图标路径非法：%s", m.Icon)
		}
	}
	m.Description = strings.TrimSpace(m.Description)
	if len([]rune(m.Description)) > 400 {
		return fmt.Errorf("应用简介不能超过 400 字")
	}
	if m.Tags == nil {
		m.Tags = []string{}
	}
	if len(m.Tags) > 8 {
		m.Tags = m.Tags[:8]
	}

	if m.Window.DefaultMode == "" {
		if m.Type == "minigame" {
			m.Window.DefaultMode = "standalone"
		} else {
			m.Window.DefaultMode = "workspace"
		}
	}
	if !validModes[m.Window.DefaultMode] {
		return fmt.Errorf("无效的默认窗口形态：%s", m.Window.DefaultMode)
	}
	if len(m.Window.SupportedModes) == 0 {
		m.Window.SupportedModes = []string{"sidepanel", "workspace", "standalone"}
	}
	for _, mode := range m.Window.SupportedModes {
		if !validModes[mode] {
			return fmt.Errorf("无效的支持窗口形态：%s", mode)
		}
	}
	if m.Window.SidepanelWidth < 320 || m.Window.SidepanelWidth > 640 {
		m.Window.SidepanelWidth = 400
	}
	if m.Window.Width < 360 || m.Window.Width > 2560 {
		m.Window.Width = 1120
	}
	if m.Window.Height < 480 || m.Window.Height > 1600 {
		m.Window.Height = 720
	}

	if m.Runtime.IsolationPolicy == "" {
		m.Runtime.IsolationPolicy = "credentialless"
	}
	if m.Runtime.IsolationPolicy != "credentialless" && m.Runtime.IsolationPolicy != "require-corp" {
		return fmt.Errorf("无效的 isolationPolicy：%s", m.Runtime.IsolationPolicy)
	}

	if m.Permissions.Scopes == nil {
		m.Permissions.Scopes = []string{"user.profile", "storage.cloud"}
	}
	for _, sc := range m.Permissions.Scopes {
		if !validScopes[sc] {
			return fmt.Errorf("不支持的权限范围：%s", sc)
		}
	}
	if m.Permissions.NetworkDomains == nil {
		m.Permissions.NetworkDomains = []string{}
	}
	if len(m.Permissions.NetworkDomains) > 16 {
		return fmt.Errorf("networkDomains 最多声明 16 个域名")
	}
	return nil
}

func normalizeZipEntryPath(raw string) (string, error) {
	replaced := strings.TrimPrefix(strings.ReplaceAll(raw, "\\", "/"), "./")
	if replaced == "" || strings.ContainsRune(replaced, 0) {
		return "", fmt.Errorf("压缩包包含非法空路径")
	}
	if strings.HasPrefix(replaced, "/") {
		return "", fmt.Errorf("压缩包禁止包含绝对路径：%s", raw)
	}
	if len(replaced) >= 2 && replaced[1] == ':' {
		return "", fmt.Errorf("压缩包禁止包含盘符路径：%s", raw)
	}
	for _, seg := range strings.Split(replaced, "/") {
		if seg == ".." {
			return "", fmt.Errorf("检测到路径穿越风险条目：%s", raw)
		}
	}
	return replaced, nil
}

// ValidateZipBundle 校验上传的 ZIP/.lecapp 构建包安全性与 orbit.manifest.json 合规性。
func ValidateZipBundle(data []byte) (*ValidatedBundle, error) {
	if int64(len(data)) > MaxBundleBytes {
		return nil, fmt.Errorf("构建包超过 100MB 上限，请改用 GitHub Releases 导入方式")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("无效的 ZIP 压缩包：%w", err)
	}

	type fileRec struct {
		file *zip.File
		name string
	}
	files := make([]fileRec, 0, len(zr.File))
	var totalUncompressed int64

	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "__MACOSX/") || f.Name == "__MACOSX" ||
			strings.HasSuffix(f.Name, "/.DS_Store") || f.Name == ".DS_Store" {
			continue
		}
		norm, err := normalizeZipEntryPath(f.Name)
		if err != nil {
			return nil, err
		}
		if f.FileInfo().IsDir() || strings.HasSuffix(norm, "/") {
			continue
		}
		if f.Mode()&0o170000 == 0o120000 {
			return nil, fmt.Errorf("安全校验失败：压缩包禁止包含符号链接 (%s)", f.Name)
		}
		totalUncompressed += int64(f.UncompressedSize64)
		if totalUncompressed > MaxUncompressedBytes {
			return nil, fmt.Errorf("解压总体积超过 250MB 安全上限")
		}
		files = append(files, fileRec{file: f, name: norm})
		if len(files) > MaxFileCount {
			return nil, fmt.Errorf("压缩包文件数量超过 %d 上限", MaxFileCount)
		}
	}

	if len(files) == 0 {
		return nil, fmt.Errorf("压缩包内没有任何文件")
	}

	// 自动识别单层外包目录（如 macOS 压缩目录产生的 my-app/orbit.manifest.json）
	stripPrefix := ""
	hasRootManifest := false
	var nestedManifests []string
	for _, fr := range files {
		if fr.name == "orbit.manifest.json" {
			hasRootManifest = true
			break
		}
		if strings.HasSuffix(fr.name, "/orbit.manifest.json") {
			nestedManifests = append(nestedManifests, fr.name)
		}
	}
	if !hasRootManifest && len(nestedManifests) == 1 {
		candidate := strings.TrimSuffix(nestedManifests[0], "orbit.manifest.json")
		allPrefixed := true
		for _, fr := range files {
			if !strings.HasPrefix(fr.name, candidate) {
				allPrefixed = false
				break
			}
		}
		if allPrefixed {
			stripPrefix = candidate
		}
	}

	fileMap := make(map[string]*zip.File, len(files))
	for _, fr := range files {
		rel := strings.TrimPrefix(fr.name, stripPrefix)
		fileMap[rel] = fr.file
	}

	manifestFile, ok := fileMap["orbit.manifest.json"]
	if !ok {
		return nil, fmt.Errorf("压缩包根目录缺少 orbit.manifest.json")
	}
	rc, err := manifestFile.Open()
	if err != nil {
		return nil, fmt.Errorf("读取 orbit.manifest.json 失败：%w", err)
	}
	manifestBytes, err := io.ReadAll(io.LimitReader(rc, 512*1024+1))
	_ = rc.Close()
	if err != nil || len(manifestBytes) > 512*1024 {
		return nil, fmt.Errorf("orbit.manifest.json 体积超限或读取失败")
	}

	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return nil, fmt.Errorf("orbit.manifest.json JSON 解析失败：%w", err)
	}
	if err := NormalizeAndValidateManifest(&manifest); err != nil {
		return nil, err
	}

	if _, hasEntry := fileMap[manifest.Entry]; !hasEntry {
		return nil, fmt.Errorf("压缩包缺少清单声明的入口文件：%s", manifest.Entry)
	}

	normalizedManifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return nil, err
	}

	sum := sha256.Sum256(data)
	out := &ValidatedBundle{
		Manifest:          manifest,
		ManifestJSON:      string(normalizedManifestBytes),
		SHA256:            hex.EncodeToString(sum[:]),
		CompressedBytes:   int64(len(data)),
		UncompressedBytes: totalUncompressed,
		FileCount:         len(files),
	}

	// 可选提取应用图标用于工坊大厅卡片展示
	if manifest.Icon != "" {
		if iconFile, exists := fileMap[manifest.Icon]; exists {
			if irc, err := iconFile.Open(); err == nil {
				iconData, rerr := io.ReadAll(io.LimitReader(irc, MaxIconBytes+1))
				_ = irc.Close()
				if rerr == nil && int64(len(iconData)) <= MaxIconBytes && len(iconData) > 0 {
					ext := strings.ToLower(path.Ext(manifest.Icon))
					if ext == ".svg" {
						out.IconBytes = iconData
						out.IconContentType = "image/svg+xml"
						out.IconExt = ".svg"
					} else {
						ct := http.DetectContentType(iconData)
						allowed := map[string]string{
							"image/png":  ".png",
							"image/jpeg": ".jpg",
							"image/webp": ".webp",
						}
						if mappedExt, ok := allowed[ct]; ok {
							out.IconBytes = iconData
							out.IconContentType = ct
							out.IconExt = mappedExt
						}
					}
				}
			}
		}
	}

	return out, nil
}

// IsAllowedGitHubReleaseURL 校验 GitHub Releases 大包导入地址合法性。
func IsAllowedGitHubReleaseURL(rawURL string) bool {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "github.com" || host == "objects.githubusercontent.com" || strings.HasSuffix(host, ".githubusercontent.com")
}
