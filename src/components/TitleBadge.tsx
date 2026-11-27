/** 彩色带图标工作室称号 Tag（左图标 + 右称号名 + 专属底色与微光描边，自适应浅色/深色主题）。 */
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
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
  Sunrise,
  Swords,
  Target,
  Trophy,
  Zap,
} from 'lucide-react';
import type { MemberTitleBadge, TitleIconKey } from '@shared/punch';
import styles from './TitleBadge.module.css';

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
    default:
      return <Crown size={size} strokeWidth={2.2} />;
  }
}

export function TitleBadge({ title, size = 'sm', dimmed = false, onClick }: TitleBadgeProps): JSX.Element {
  const iconPx = size === 'xs' ? 11 : size === 'md' ? 14 : 12;
  const themeClass = styles[`theme_${title.theme}`] ?? styles.theme_amber;
  const sizeClass = styles[`size_${size}`] ?? styles.size_sm;
  const tooltip = `${title.name}：${title.description}（提出人：${title.proposer}）`;

  const className = [
    styles.badge,
    themeClass,
    sizeClass,
    dimmed ? styles.dimmed : '',
    onClick ? styles.clickable : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (onClick) {
    return (
      <button type="button" className={className} title={tooltip} onClick={onClick}>
        <span className={styles.icon} aria-hidden="true">
          {renderTitleIcon(title.icon, iconPx)}
        </span>
        <span className={styles.label}>{title.name}</span>
      </button>
    );
  }

  return (
    <span className={className} title={tooltip}>
      <span className={styles.icon} aria-hidden="true">
        {renderTitleIcon(title.icon, iconPx)}
      </span>
      <span className={styles.label}>{title.name}</span>
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
              {titles.map((t) => (
                <div key={t.id} className={styles.popoverRow}>
                  <TitleBadge title={t} size="xs" />
                  <span className={styles.popoverDesc}>{t.description}</span>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
