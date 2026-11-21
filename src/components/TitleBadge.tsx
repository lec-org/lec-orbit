/** 彩色带图标工作室称号 Tag（左图标 + 右称号名 + 专属底色与微光描边，自适应浅色/深色主题）。 */
import type { JSX } from 'react';
import {
  CalendarCheck,
  Crosshair,
  Crown,
  Egg,
  Flame,
  Hourglass,
  Moon,
  Sunrise,
  Swords,
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
  onBadgeClick?: (title: MemberTitleBadge) => void;
}

export function TitleBadgeList({
  titles,
  size = 'xs',
  maxVisible = 2,
  onBadgeClick,
}: TitleBadgeListProps): JSX.Element | null {
  if (!titles || titles.length === 0) return null;
  const visible = titles.slice(0, maxVisible);
  return (
    <span className={styles.list}>
      {visible.map((t) => (
        <TitleBadge
          key={t.id}
          title={t}
          size={size}
          onClick={onBadgeClick ? () => onBadgeClick(t) : undefined}
        />
      ))}
    </span>
  );
}
