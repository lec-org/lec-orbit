/** 工作室产品导航页：聚合日常协作、研发部署与管理后台全部入口，支持搜索、分类筛选、内嵌直达与一键复制链接。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type MouseEvent } from 'react';
import { Button, Empty, Input, SegmentedControl, Tag } from '@lec-space/liquidglass';
import { BookOpen, Check, Clock3, Copy, ExternalLink, Search } from '@lec-space/icons';
import {
  ArrowUpRight,
  Code2,
  GitBranch,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Palette,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import {
  STUDIO_PRODUCTS,
  STUDIO_PRODUCT_GROUPS,
  type ProductGroupId,
  type ProductIconKey,
  type StudioProductItem,
} from '@shared/products';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './ProductNav.module.css';

type FilterGroup = 'all' | ProductGroupId;

function renderProductIcon(icon: ProductIconKey): { node: JSX.Element; isBrandImg?: boolean } {
  switch (icon) {
    case 'orbit':
      return {
        node: <img src="./icon.png" alt="" className={styles.brandImg} />,
        isBrandImg: true,
      };
    case 'line':
      return {
        node: <img src="./line-icon.png" alt="" className={styles.brandImg} />,
        isBrandImg: true,
      };
    case 'website':
      return { node: <Globe size={20} /> };
    case 'doc':
      return { node: <BookOpen size={20} /> };
    case 'oj':
      return { node: <Code2 size={20} /> };
    case 'drive':
      return { node: <HardDrive size={20} /> };
    case 'punch':
      return { node: <Clock3 size={20} /> };
    case 'devtron':
      return { node: <Rocket size={20} /> };
    case 'github':
      return { node: <GitBranch size={20} /> };
    case 'liquidglass':
      return { node: <Layers size={20} /> };
    case 'icons':
      return { node: <Palette size={20} /> };
    case 'logto':
      return { node: <KeyRound size={20} /> };
    case 'logto-admin':
      return { node: <ShieldCheck size={20} /> };
    case 'punch-admin':
      return { node: <SlidersHorizontal size={20} /> };
  }
}

export function ProductNavPage(): JSX.Element {
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const [groupFilter, setGroupFilter] = useState<FilterGroup>('all');
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 支持按 / 快速聚焦搜索框，按 Esc 清空搜索
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (event.key === '/' && !inEditable) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'Escape' && document.activeElement === searchRef.current && query) {
        setQuery('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [query]);

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return STUDIO_PRODUCTS.filter((item) => {
      if (groupFilter !== 'all' && item.group !== groupFilter) return false;
      if (!needle) return true;
      const haystack = [
        item.name,
        item.subtitle,
        item.description,
        item.hostLabel,
        item.url,
        ...item.keywords,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [groupFilter, query]);

  const groupedSections = useMemo(() => {
    return STUDIO_PRODUCT_GROUPS.map((group) => ({
      group,
      items: filteredProducts.filter((item) => item.group === group.id),
    })).filter((entry) => entry.items.length > 0);
  }, [filteredProducts]);

  const openExternal = (item: StudioProductItem) => {
    void getOrbitClient().system.openExternal(item.url);
  };

  const handleCardPrimaryAction = (item: StudioProductItem) => {
    if (item.inAppTab === 'doc') {
      setActiveTab('doc');
      return;
    }
    openExternal(item);
  };

  const handleCopyUrl = (event: MouseEvent, item: StudioProductItem) => {
    event.stopPropagation();
    void getOrbitClient().system.copyText(item.url);
    setCopiedId(item.id);
    notifyToast({
      tone: 'success',
      title: `已复制 ${item.name} 链接`,
      description: item.url,
    });
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === item.id ? null : prev));
    }, 1800);
  };

  const handleOpenExternalClick = (event: MouseEvent, item: StudioProductItem) => {
    event.stopPropagation();
    openExternal(item);
  };

  const handleOpenInAppClick = (event: MouseEvent, item: StudioProductItem) => {
    event.stopPropagation();
    if (item.inAppTab) {
      setActiveTab(item.inAppTab);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>应用导航</h1>
          <p className={styles.subheading}>
            乐程工作室全部产品、研发设施与后台入口 · 共 {STUDIO_PRODUCTS.length} 项服务
          </p>
        </div>
      </header>

      <div className={styles.toolbar}>
        <SegmentedControl
          value={groupFilter}
          onValueChange={(value) => setGroupFilter(value as FilterGroup)}
          items={[
            { value: 'all', label: '全部' },
            { value: 'daily', label: '日常协作' },
            { value: 'dev', label: '研发与部署' },
            { value: 'admin', label: '管理后台' },
          ]}
        />

        <div className={styles.searchWrap}>
          <Input
            ref={searchRef}
            variant="fill"
            type="search"
            icon={<Search size={15} />}
            className={styles.searchInput}
            placeholder="搜索产品名、域名或用途（按 /）"
            value={query}
            onValueChange={setQuery}
          />
        </div>
      </div>

      {groupedSections.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty
            title="没有找到匹配的产品入口"
            description={`未找到包含「${query}」的工作室产品，试试搜索 Devtron、Logto、Line 或 OJ。`}
          >
            <Button
              variant="glass"
              onClick={() => {
                setQuery('');
                setGroupFilter('all');
              }}
            >
              查看全部入口
            </Button>
          </Empty>
        </div>
      ) : (
        <div className={styles.sections}>
          {groupedSections.map(({ group, items }) => (
            <section key={group.id} className={styles.section} aria-label={group.label}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>{group.label}</h2>
                <span className={styles.sectionCaption}>{group.caption}</span>
                <span className={styles.sectionCount}>{items.length}</span>
              </div>

              <div className={styles.grid}>
                {items.map((item) => {
                  const rendered = renderProductIcon(item.icon);
                  const isCopied = copiedId === item.id;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      className={styles.card}
                      style={{ '--card-accent': item.accent } as CSSProperties}
                      onClick={() => handleCardPrimaryAction(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleCardPrimaryAction(item);
                        }
                      }}
                    >
                      <div className={styles.cardTop}>
                        <span
                          className={`${styles.iconTile} ${rendered.isBrandImg ? styles.iconTileBrand : ''}`}
                        >
                          {rendered.node}
                        </span>
                        <div className={styles.titleBlock}>
                          <div className={styles.titleRow}>
                            <h3 className={styles.name}>{item.name}</h3>
                            {item.badge && (
                              <Tag tone={item.badge.tone}>{item.badge.label}</Tag>
                            )}
                          </div>
                          <span className={styles.subtitle}>{item.subtitle}</span>
                        </div>
                        <ArrowUpRight size={16} className={styles.openArrow} aria-hidden />
                      </div>

                      <p className={styles.description}>{item.description}</p>

                      <div className={styles.cardFooter}>
                        <span className={styles.hostLabel} title={item.url}>
                          {item.hostLabel}
                        </span>
                        <div className={styles.footerActions}>
                          {item.inAppTab && (
                            <button
                              type="button"
                              className={styles.inAppChip}
                              onClick={(e) => handleOpenInAppClick(e, item)}
                            >
                              应用内打开
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.actionIconBtn}
                            title="复制链接"
                            aria-label={`复制 ${item.name} 链接`}
                            onClick={(e) => handleCopyUrl(e, item)}
                          >
                            {isCopied ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                          <button
                            type="button"
                            className={styles.actionIconBtn}
                            title="在浏览器中打开"
                            aria-label={`在浏览器中打开 ${item.name}`}
                            onClick={(e) => handleOpenExternalClick(e, item)}
                          >
                            <ExternalLink size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
