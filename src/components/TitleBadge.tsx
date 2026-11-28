/** 彩色带图标工作室称号 Tag（左图标 + 右称号名 + 专属底色与微光描边，自适应浅色/深色主题）。 */
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  BatteryLow,
  BookOpen,
  CalendarCheck,
  Clover,
  Crosshair,
  Crown,
  Dices,
  Egg,
  Flame,
  Ghost,
  GitPullRequest,
  GraduationCap,
  Hourglass,
  Layers,
  Library,
  Moon,
  Skull,
  Sparkles,
  Star,
  Sun,
  Sunrise,
  Swords,
  Target,
  Timer,
  Trophy,
  Zap,
} from 'lucide-react';
import {
  computeTitleAchievementTier,
  formatTitleTierText,
  type MemberTitleBadge,
  type TitleIconKey,
} from '@shared/punch';
import styles from './TitleBadge.module.css';

interface TitleTierIconsProps {
  count: number;
  stackable?: boolean;
  /** compact 用于徽章内紧凑显示（最多 2 阶），full 用于称号图鉴卡片与悬浮卡完整展开（1–4 颗图标）。 */
  mode?: 'compact' | 'full';
  size?: number;
}

/** 渲染标准 5 进制（逢 5 进 1）的皇冠 / 太阳 / 月亮 / 星星成就阶位图标串。 */
export function TitleTierIcons({
  count,
  stackable = true,
  mode = 'compact',
  size = 11,
}: TitleTierIconsProps): JSX.Element | null {
  const tier = computeTitleAchievementTier(count, stackable);
  if (!stackable || tier.points <= 0) return null;

  const allGroups: Array<{
    key: 'crown' | 'sun' | 'moon' | 'star';
    amount: number;
    className: string;
    renderIcon: (idx: number) => JSX.Element;
  }> = [
    {
      key: 'crown',
      amount: tier.crowns,
      className: styles.tierCrown,
      renderIcon: (idx) => (
        <Crown key={`cr-${idx}`} size={size} strokeWidth={2.2} fill="currentColor" />
      ),
    },
    {
      key: 'sun',
      amount: tier.suns,
      className: styles.tierSun,
      renderIcon: (idx) => (
        <Sun key={`su-${idx}`} size={size} strokeWidth={2.2} fill="currentColor" />
      ),
    },
    {
      key: 'moon',
      amount: tier.moons,
      className: styles.tierMoon,
      renderIcon: (idx) => (
        <Moon key={`mo-${idx}`} size={size} strokeWidth={2.1} fill="currentColor" />
      ),
    },
    {
      key: 'star',
      amount: tier.stars,
      className: styles.tierStar,
      renderIcon: (idx) => (
        <Star key={`st-${idx}`} size={size} strokeWidth={2} fill="currentColor" />
      ),
    },
  ];
  const groups = allGroups.filter((g) => g.amount > 0);

  if (groups.length === 0) return null;

  if (mode === 'compact') {
    const visibleGroups = groups.slice(0, 2);
    return (
      <span
        className={styles.tierCompactWrap}
        aria-label={`成就阶位：${formatTitleTierText(tier)}`}
      >
        {visibleGroups.map((g) => (
          <span key={g.key} className={`${styles.tierUnit} ${g.className}`}>
            {g.renderIcon(0)}
            {g.amount > 1 && <span className={styles.tierMul}>{g.amount}</span>}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span
      className={styles.tierFullWrap}
      aria-label={`成就阶位：${formatTitleTierText(tier)}`}
    >
      {groups.map((g) => (
        <span key={g.key} className={`${styles.tierUnit} ${g.className}`}>
          {g.amount <= 5 ? (
            Array.from({ length: g.amount }, (_, idx) => g.renderIcon(idx))
          ) : (
            <>
              {g.renderIcon(0)}
              <span className={styles.tierMul}>×{g.amount}</span>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

interface TitleBadgeProps {
  title: MemberTitleBadge;
  size?: 'xs' | 'sm' | 'md';
  dimmed?: boolean;
  onClick?: () => void;
}

function renderTitleIcon(icon: TitleIconKey, size: number): JSX.Element {
  switch (icon) {
    case 'crown':
      return <Crown size={size} strokeWidth={2.2} />;
    case 'calendar-check':
      return <CalendarCheck size={size} strokeWidth={2.2} />;
    case 'trophy':
      return <Trophy size={size} strokeWidth={2.2} />;
    case 'moon':
      return <Moon size={size} strokeWidth={2.2} />;
    case 'sunrise':
      return <Sunrise size={size} strokeWidth={2.2} />;
    case 'zap':
      return <Zap size={size} strokeWidth={2.2} />;
    case 'crosshair':
      return <Crosshair size={size} strokeWidth={2.2} />;
    case 'flame':
      return <Flame size={size} strokeWidth={2.2} />;
    case 'egg':
      return <Egg size={size} strokeWidth={2.2} />;
    case 'swords':
      return <Swords size={size} strokeWidth={2.2} />;
    case 'hourglass':
      return <Hourglass size={size} strokeWidth={2.2} />;
    case 'target':
      return <Target size={size} strokeWidth={2.2} />;
    case 'dices':
      return <Dices size={size} strokeWidth={2.2} />;
    case 'skull':
      return <Skull size={size} strokeWidth={2.2} />;
    case 'ghost':
      return <Ghost size={size} strokeWidth={2.2} />;
    case 'git-pull-request':
      return <GitPullRequest size={size} strokeWidth={2.2} />;
    case 'clover':
      return <Clover size={size} strokeWidth={2.2} />;
    case 'layers':
      return <Layers size={size} strokeWidth={2.2} />;
    case 'library':
      return <Library size={size} strokeWidth={2.2} />;
    case 'book-open':
      return <BookOpen size={size} strokeWidth={2.2} />;
    case 'graduation-cap':
      return <GraduationCap size={size} strokeWidth={2.2} />;
    case 'sparkles':
      return <Sparkles size={size} strokeWidth={2.2} />;
    case 'timer':
      return <Timer size={size} strokeWidth={2.2} />;
    case 'battery-low':
      return <BatteryLow size={size} strokeWidth={2.2} />;
    case 'alert-triangle':
      return <AlertTriangle size={size} strokeWidth={2.2} />;
    default:
      return <Crown size={size} strokeWidth={2.2} />;
  }
}

export function TitleBadge({ title, size = 'sm', dimmed = false, onClick }: TitleBadgeProps): JSX.Element {
  const iconPx = size === 'xs' ? 11 : size === 'md' ? 14 : 12;
  const tierIconPx = size === 'xs' ? 10 : size === 'md' ? 12 : 11;
  const themeClass = styles[`theme_${title.theme}`] ?? styles.theme_amber;
  const sizeClass = styles[`size_${size}`] ?? styles.size_sm;
  const unlockCount = title.unlockCount ?? 0;
  const stackable = title.stackable !== false;
  const tier = computeTitleAchievementTier(unlockCount, stackable);
  const tierSummary =
    unlockCount > 0
      ? stackable && tier.points > 0
        ? `（${formatTitleTierText(tier)} · 累计达成 ${unlockCount} 次）`
        : stackable
          ? `（累计达成 ${unlockCount} 次）`
          : '（一次性里程碑）'
      : '';
  const tooltip = `${title.name}${tierSummary}：${title.description}（提出人：${title.proposer}）`;

  const className = [
    styles.badge,
    themeClass,
    sizeClass,
    dimmed ? styles.dimmed : '',
    onClick ? styles.clickable : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <span className={styles.icon} aria-hidden="true">
        {renderTitleIcon(title.icon, iconPx)}
      </span>
      <span className={styles.label}>{title.name}</span>
      {stackable && unlockCount >= 2 && (
        <TitleTierIcons count={unlockCount} stackable={stackable} mode="compact" size={tierIconPx} />
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={className} title={tooltip} onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <span className={className} title={tooltip}>
      {content}
    </span>
  );
}

interface TitleBadgeListProps {
  titles?: MemberTitleBadge[];
  size?: 'xs' | 'sm' | 'md';
  maxVisible?: number;
  /** 强制单行排列不换行（用于排行榜等高密度列表） */
  singleLine?: boolean;
  /** 超出 maxVisible 时折叠为 +N 省略胶囊，并在悬停时以悬浮卡展示全部称号及说明 */
  overflowPopover?: boolean;
  onBadgeClick?: (title: MemberTitleBadge) => void;
}

const POPOVER_MAX_WIDTH = 276;

export function TitleBadgeList({
  titles,
  size = 'xs',
  maxVisible = 2,
  singleLine = false,
  overflowPopover = false,
  onBadgeClick,
}: TitleBadgeListProps): JSX.Element | null {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  const count = titles?.length ?? 0;
  const hiddenCount = Math.max(0, count - maxVisible);
  const canShowPopover = overflowPopover && hiddenCount > 0;

  useEffect(() => {
    if (!popoverStyle) return;
    const dismiss = () => setPopoverStyle(null);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [popoverStyle]);

  if (!titles || titles.length === 0) return null;
  const visible = titles.slice(0, maxVisible);

  const openPopover = () => {
    if (!canShowPopover || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - POPOVER_MAX_WIDTH - 12),
    );
    const placeAbove = rect.top > 180;
    setPopoverStyle(
      placeAbove
        ? {
            left,
            bottom: window.innerHeight - rect.top + 8,
          }
        : {
            left,
            top: rect.bottom + 8,
          },
    );
  };

  const closePopover = () => {
    if (popoverStyle) setPopoverStyle(null);
  };

  return (
    <>
      <span
        ref={wrapRef}
        className={`${styles.list} ${singleLine ? styles.listSingleLine : ''}`}
        onMouseEnter={canShowPopover ? openPopover : undefined}
        onMouseLeave={canShowPopover ? closePopover : undefined}
      >
        {visible.map((t) => (
          <TitleBadge
            key={t.id}
            title={t}
            size={size}
            onClick={onBadgeClick ? () => onBadgeClick(t) : undefined}
          />
        ))}
        {overflowPopover && hiddenCount > 0 && (
          <span
            className={`${styles.morePill} ${styles[`size_${size}`] ?? styles.size_xs}`}
            aria-label={`还有 ${hiddenCount} 个称号，悬停查看全部`}
          >
            +{hiddenCount}
          </span>
        )}
      </span>
      {canShowPopover &&
        popoverStyle &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className={styles.popover} style={popoverStyle} role="tooltip">
            <div className={styles.popoverHeader}>全部称号（{titles.length}）</div>
            <div className={styles.popoverItems}>
              {titles.map((t) => {
                const count = t.unlockCount ?? 0;
                const stackable = t.stackable !== false;
                const tier = computeTitleAchievementTier(count, stackable);
                return (
                  <div key={t.id} className={styles.popoverRow}>
                    <div className={styles.popoverRowTop}>
                      <TitleBadge title={t} size="xs" />
                      {stackable && count >= 1 && (
                        <span className={styles.popoverTierMeta}>
                          {tier.points > 0 && (
                            <TitleTierIcons count={count} stackable mode="full" size={11} />
                          )}
                          <span>×{count}</span>
                        </span>
                      )}
                    </div>
                    <span className={styles.popoverDesc}>{t.description}</span>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
