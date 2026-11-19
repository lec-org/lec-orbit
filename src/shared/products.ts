/**
 * LEC 软件工作室产品导航清单（纯数据定义，零 Electron/React 耦合，后续可直接复用到独立 Web 导航站）。
 */

export type ProductGroupId = 'daily' | 'dev' | 'admin';

export type ProductBadgeTone = 'info' | 'warning' | 'success' | 'neutral';

export type ProductIconKey =
  | 'orbit'
  | 'line'
  | 'website'
  | 'doc'
  | 'oj'
  | 'drive'
  | 'punch'
  | 'devtron'
  | 'github'
  | 'liquidglass'
  | 'icons'
  | 'logto'
  | 'logto-admin'
  | 'punch-admin';

export interface StudioProductGroup {
  id: ProductGroupId;
  label: string;
  caption: string;
}

export interface StudioProductItem {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  url: string;
  hostLabel: string;
  group: ProductGroupId;
  icon: ProductIconKey;
  /** 仅用于卡片配色点缀 */
  accent: string;
  /** 可选身份/性质角标（全员可见，管理员/运维向产品显式标注） */
  badge?: {
    label: string;
    tone: ProductBadgeTone;
  };
  /** 是否允许在 Orbit 内直接切到对应内置标签页 */
  inAppTab?: 'doc' | 'punch-today';
  /** 搜索关键词（支持中英文、简称、别名） */
  keywords: readonly string[];
}

export const STUDIO_PRODUCT_GROUPS: readonly StudioProductGroup[] = [
  {
    id: 'daily',
    label: '日常协作',
    caption: '工作室官网、桌面端与高频团队应用',
  },
  {
    id: 'dev',
    label: '研发与部署',
    caption: '代码仓库、CI/CD 发布平台与共享设计资产',
  },
  {
    id: 'admin',
    label: '管理后台',
    caption: '统一身份认证、权限控制台与考勤运维入口',
  },
];

export const STUDIO_PRODUCTS: readonly StudioProductItem[] = [
  // ── 日常协作 ──
  {
    id: 'website',
    name: '乐程官网',
    subtitle: 'Official Website',
    description: '乐程软件工作室官方网站，展示工作室简介、方向介绍、成员风采与招新动态。',
    url: 'https://lecspace.top',
    hostLabel: 'lecspace.top',
    group: 'daily',
    icon: 'website',
    accent: '#2563eb',
    keywords: ['官网', '主页', '官方网站', 'website', 'home', 'lec', '乐程', '招新'],
  },
  {
    id: 'lec-doc',
    name: 'LecDoc 云文档',
    subtitle: '团队知识库',
    description: '工作室 Wiki 与多人实时协同文档，沉淀项目方案、学习路线与团队规范。',
    url: 'https://doc.lecspace.top',
    hostLabel: 'doc.lecspace.top',
    group: 'daily',
    icon: 'doc',
    accent: '#0ea5e9',
    badge: { label: '已内嵌', tone: 'success' },
    inAppTab: 'doc',
    keywords: ['文档', '云文档', '知识库', 'wiki', 'doc', 'lecdoc', 'docmost'],
  },
  {
    id: 'lec-oj',
    name: 'LecOJ 在线判题',
    subtitle: '题库与算法训练',
    description: '工作室算法题库、题单训练与独立沙箱在线评测平台，支持 LecSSO 一键登录。',
    url: 'https://code.lecspace.top',
    hostLabel: 'code.lecspace.top',
    group: 'daily',
    icon: 'oj',
    accent: '#8b5cf6',
    keywords: ['oj', 'lecoj', '判题', '算法', '题库', '刷题', 'code', '评测', '训练'],
  },
  {
    id: 'lec-drive',
    name: 'LecDrive 云盘素材',
    subtitle: '团队图床与静态资源',
    description: '团队图片上传、共享素材管理与公网直链分发空间。',
    url: 'https://drive.lecspace.top',
    hostLabel: 'drive.lecspace.top',
    group: 'daily',
    icon: 'drive',
    accent: '#10b981',
    keywords: ['云盘', '图床', '图片', '素材', '文件', '直链', 'drive', 'lecdrive', '存储'],
  },
  {
    id: 'lec-punch',
    name: 'LecPunch 考勤打卡',
    subtitle: '网页版考勤与榜单',
    description: '团队日常专注打卡、周时长统计、卡牌工坊与工作室活动网页版入口。',
    url: 'https://punch.lecspace.top',
    hostLabel: 'punch.lecspace.top',
    group: 'daily',
    icon: 'punch',
    accent: '#f59e0b',
    inAppTab: 'punch-today',
    keywords: ['打卡', '考勤', '专注', '时长', 'punch', 'lecpunch', '卡牌', '周榜'],
  },
  {
    id: 'orbit',
    name: 'Orbit 伴程',
    subtitle: '工作室桌面工作台',
    description: '集成考勤打卡、悬浮球、团队文档与跨应用通知的工作室桌面端，访问官网查看特性与下载安装包。',
    url: 'https://lec-org.github.io/lec-orbit/',
    hostLabel: 'lec-org.github.io/lec-orbit',
    group: 'daily',
    icon: 'orbit',
    accent: '#2563eb',
    badge: { label: '当前应用', tone: 'info' },
    keywords: ['orbit', '伴程', '客户端', '桌面端', 'desktop', '下载', '官网', 'release', '更新'],
  },
  {
    id: 'line',
    name: 'Line 编辑器',
    subtitle: 'LEC Code Editor',
    description: '乐程工作室基于 Zed 深度定制的高性能代码编辑器，查看源码与发布版本。',
    url: 'https://github.com/lec-org/lec-editor',
    hostLabel: 'lec-org/lec-editor',
    group: 'daily',
    icon: 'line',
    accent: '#1d4ed8',
    keywords: ['line', '编辑器', 'editor', 'zed', 'ide', '代码', 'lec-editor'],
  },

  // ── 研发与部署 ──
  {
    id: 'devtron',
    name: 'Devtron 发布平台',
    subtitle: 'CI/CD · K3s 运维',
    description: '统一管理 lec-org 业务项目的构建流水线、容器镜像发布、健康检查与版本回滚。',
    url: 'https://devtron.lecspace.top/dashboard/',
    hostLabel: 'devtron.lecspace.top',
    group: 'dev',
    icon: 'devtron',
    accent: '#0284c7',
    badge: { label: '研发 / 管理员', tone: 'warning' },
    keywords: ['devtron', 'ci', 'cd', '部署', '发布', '流水线', 'k3s', 'k8s', '运维', '回滚'],
  },
  {
    id: 'github-org',
    name: 'GitHub 组织',
    subtitle: 'lec-org 代码托管',
    description: '乐程软件工作室 GitHub 组织主页，集中管理各产品仓库、PR 评审与版本发布。',
    url: 'https://github.com/lec-org',
    hostLabel: 'github.com/lec-org',
    group: 'dev',
    icon: 'github',
    accent: '#334155',
    keywords: ['github', 'git', '代码', '仓库', 'repo', 'lec-org', '开源'],
  },
  {
    id: 'liquidglass',
    name: 'Liquid Glass 组件库',
    subtitle: '@lec-space/liquidglass',
    description: '工作室共享液态玻璃风格 React 组件库文档站，提供交互预览与接入规范。',
    url: 'https://lec-org.github.io/liquidglass/',
    hostLabel: 'lec-org.github.io/liquidglass',
    group: 'dev',
    icon: 'liquidglass',
    accent: '#6366f1',
    keywords: ['liquidglass', '组件库', 'ui', 'react', '设计', '液态玻璃', '前端'],
  },
  {
    id: 'lec-icons',
    name: 'LEC Icons 图标库',
    subtitle: '@lec-space/icons',
    description: '工作室共享品牌图标与 Lucide 界面图标站，支持按分类检索并一键复制导入代码。',
    url: 'https://lec-org.github.io/lec-icons/',
    hostLabel: 'lec-org.github.io/lec-icons',
    group: 'dev',
    icon: 'icons',
    accent: '#ec4899',
    keywords: ['icons', '图标', '图标库', 'svg', '素材', 'brand', 'lucide'],
  },

  // ── 管理后台 ──
  {
    id: 'logto',
    name: 'Logto 统一身份',
    subtitle: 'LecSSO 认证中心',
    description: '工作室统一账号登录、个人安全设置与 OIDC 身份认证入口。',
    url: 'https://sso.lecspace.top',
    hostLabel: 'sso.lecspace.top',
    group: 'admin',
    icon: 'logto',
    accent: '#14b8a6',
    keywords: ['logto', 'sso', 'lecsso', '统一身份', '登录', '认证', 'oidc', '账号'],
  },
  {
    id: 'logto-admin',
    name: 'Logto Admin 控制台',
    subtitle: '身份与权限管理',
    description: '管理工作室成员账号、组织角色（管理员/队长/成员）与各应用 OIDC 权限配置。',
    url: 'https://sso-admin.lecspace.top',
    hostLabel: 'sso-admin.lecspace.top',
    group: 'admin',
    icon: 'logto-admin',
    accent: '#d97706',
    badge: { label: '管理员', tone: 'warning' },
    keywords: ['logto-admin', 'logto', 'admin', 'sso-admin', '控制台', '身份后台', '权限', '角色', '成员'],
  },
  {
    id: 'punch-admin',
    name: 'LecPunch 管理后台',
    subtitle: '考勤与卡牌运维',
    description: '管理考勤考核周期、打卡网络策略、成员补录及卡牌工坊配置。',
    url: 'https://punch.lecspace.top/admin-dashboard',
    hostLabel: 'punch.lecspace.top/admin-dashboard',
    group: 'admin',
    icon: 'punch-admin',
    accent: '#ea580c',
    badge: { label: '管理员', tone: 'warning' },
    keywords: ['punch', 'admin', '考勤后台', '管理后台', '打卡管理', '考核'],
  },
];
