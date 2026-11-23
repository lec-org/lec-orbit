import { defineConfig } from 'vitepress';

const base = process.env.DOCS_BASE ?? '/lec-orbit/docs/';

export default defineConfig({
  base,
  lang: 'zh-CN',
  title: 'Orbit 工坊开发者文档',
  description: '乐程软件工作室（LEC）Orbit 桌面小程序与小游戏容器开发指南（支持 Web / Cocos / Unity / Godot）',
  cleanUrls: false,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}orbit-icon.png` }],
    ['meta', { name: 'theme-color', content: '#0a84ff' }],
  ],

  themeConfig: {
    logo: '/orbit-icon.png',
    siteTitle: 'Orbit 工坊文档',

    nav: [
      { text: '开发指南', link: '/guide/getting-started', activeMatch: '/guide/' },
      {
        text: '应用与引擎',
        activeMatch: '/engines/',
        items: [
          { text: '小程序（Web / React / Vue）', link: '/engines/miniapp-web' },
          { text: 'Cocos Creator 3.x', link: '/engines/cocos' },
          { text: 'Unity WebGL / WebGPU', link: '/engines/unity' },
          { text: 'Godot 4 Web', link: '/engines/godot' },
        ],
      },
      { text: 'SDK 参考', link: '/api/orbit-sdk', activeMatch: '/api/' },
      { text: '打包与发布', link: '/publish/packaging-and-upload', activeMatch: '/publish/' },
      { text: 'Orbit 官网', link: 'https://lec-org.github.io/lec-orbit/' },
    ],

    sidebar: [
      {
        text: '快速上手',
        items: [
          { text: '10 分钟快速开始', link: '/guide/getting-started' },
          { text: 'orbit.manifest.json 规范', link: '/guide/manifest' },
          { text: '三态窗口与无损切换', link: '/guide/window-modes' },
          { text: '安全沙箱与权限边界', link: '/guide/sandbox-security' },
        ],
      },
      {
        text: '小程序与游戏引擎接入',
        items: [
          { text: '小程序（Web / Liquid Glass）', link: '/engines/miniapp-web' },
          { text: 'Cocos Creator 3.x', link: '/engines/cocos' },
          { text: 'Unity WebGL / WebGPU', link: '/engines/unity' },
          { text: 'Godot 4', link: '/engines/godot' },
        ],
      },
      {
        text: 'SDK 与容器能力',
        items: [
          { text: 'window.orbitSDK API 参考', link: '/api/orbit-sdk' },
        ],
      },
      {
        text: '发布、分发与排错',
        items: [
          { text: '打包、上传与审核流', link: '/publish/packaging-and-upload' },
          { text: '常见问题排错手册', link: '/publish/troubleshooting' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/lec-org/lec-orbit' },
    ],

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            noResultsText: '未找到相关内容',
            resetButtonTitle: '清空查询',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },

    lastUpdated: {
      text: '最后更新于',
    },

    darkModeSwitchLabel: '外观主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    sidebarMenuLabel: '目录导航',
    returnToTopLabel: '回到顶部',

    footer: {
      message: 'LEC（乐程）软件工作室 · 仅限工作室内部研发与作品分发使用',
      copyright: 'Copyright © 2026 LEC Software Studio',
    },
  },
});
