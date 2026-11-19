/** Orbit 官网交互脚本：主题切换、窗口预览切页、自动识别访客系统并拉取最新 GitHub Releases 下载直链。 */
(() => {
  const REPO = 'lec-org/lec-orbit';
  const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

  // 1. 主题初始化与切换
  const root = document.documentElement;
  const savedTheme = localStorage.getItem('orbit-site-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
  }

  applyTheme(savedTheme || (systemDark.matches ? 'dark' : 'light'));
  systemDark.addEventListener('change', (e) => {
    if (!localStorage.getItem('orbit-site-theme')) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('orbit-site-theme', next);
    applyTheme(next);
  });

  // 2. 交互式窗口预览切换
  const tabs = document.querySelectorAll('.preview-tab');
  const panels = document.querySelectorAll('.mock-panel');
  const navItems = document.querySelectorAll('.mock-nav-item');

  function activateTab(tabId) {
    tabs.forEach((btn) => {
      const active = btn.getAttribute('data-tab') === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    panels.forEach((panel) => {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === tabId);
    });
    navItems.forEach((item) => {
      item.classList.toggle('active', item.getAttribute('data-nav') === tabId);
    });
  }

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      if (tabId) activateTab(tabId);
    });
  });
  activateTab('focus');

  // 3. 复制 macOS 命令
  const copyBtn = document.getElementById('copy-mac-cmd');
  const fixCmd = document.getElementById('mac-fix-cmd');
  copyBtn?.addEventListener('click', async () => {
    const text = fixCmd?.textContent?.trim() || 'xattr -cr /Applications/Orbit.app';
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '已复制';
      setTimeout(() => {
        copyBtn.textContent = '复制命令';
      }, 1800);
    } catch {
      // 忽略剪贴板权限拒绝
    }
  });

  // 4. 识别访客平台
  function detectPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) return 'win-x64';
    if (ua.includes('mac os') || ua.includes('macintosh')) {
      // 现代 Mac 默认优先推荐 Apple Silicon，页面下方同时提供 Intel 直链
      return 'mac-arm64';
    }
    return 'mac-arm64';
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function findAsset(assets, predicate) {
    return (assets || []).find((a) => predicate((a.name || '').toLowerCase())) || null;
  }

  const detected = detectPlatform();
  const cardMap = {
    'mac-arm64': document.getElementById('card-mac-arm64'),
    'mac-x64': document.getElementById('card-mac-x64'),
    'win-x64': document.getElementById('card-win-x64'),
  };
  cardMap[detected]?.classList.add('recommended');

  // 5. 动态拉取最新 GitHub Releases 制品链接
  async function loadLatestRelease() {
    const pillText = document.getElementById('release-pill-text');
    const versionLine = document.getElementById('release-version-line');
    const primaryBtn = document.getElementById('primary-download-btn');
    const primaryLabel = document.getElementById('primary-download-label');

    try {
      const res = await fetch(LATEST_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const version = data.tag_name || 'v0.1.0';
      const published = data.published_at
        ? new Date(data.published_at).toLocaleDateString('zh-CN')
        : '';
      const assets = Array.isArray(data.assets) ? data.assets : [];

      const macArm =
        findAsset(assets, (n) => n.endsWith('.dmg') && (n.includes('arm64') || n.includes('aarch64'))) ||
        findAsset(assets, (n) => n.endsWith('.dmg') && !n.includes('x64') && !n.includes('intel'));
      const macX64 = findAsset(assets, (n) => n.endsWith('.dmg') && (n.includes('x64') || n.includes('intel')));
      const winX64 = findAsset(assets, (n) => n.endsWith('.exe') && !n.endsWith('.blockmap'));

      if (pillText) {
        pillText.textContent = `最新版本 ${version}${published ? ` · 发布于 ${published}` : ''}`;
      }
      if (versionLine) {
        versionLine.textContent = `当前最新正式版 ${version}${published ? `（${published}）` : ''} · 由 GitHub Actions 自动构建发布`;
      }

      const bindCard = (key, asset) => {
        const btn = document.getElementById(`btn-${key}`);
        const meta = document.getElementById(`meta-${key}`);
        if (asset) {
          if (btn) btn.setAttribute('href', asset.browser_download_url);
          if (meta) meta.textContent = `${asset.name} · ${formatSize(asset.size)}`;
        } else {
          if (btn) btn.setAttribute('href', data.html_url || RELEASES_PAGE);
        }
      };

      bindCard('mac-arm64', macArm);
      bindCard('mac-x64', macX64);
      bindCard('win-x64', winX64);

      const primaryAsset =
        detected === 'win-x64' ? winX64 || macArm : macArm || macX64 || winX64;
      if (primaryAsset && primaryBtn && primaryLabel) {
        primaryBtn.setAttribute('href', primaryAsset.browser_download_url);
        primaryLabel.textContent =
          detected === 'win-x64'
            ? `下载 Windows 版 (${version})`
            : `下载 macOS Apple Silicon (${version})`;
      } else if (primaryLabel) {
        primaryLabel.textContent = `前往 Releases 下载 ${version}`;
      }
    } catch {
      if (versionLine) {
        versionLine.textContent = '安装包托管于 GitHub Releases，点击下方按钮前往下载页。';
      }
    }
  }

  void loadLatestRelease();
})();
