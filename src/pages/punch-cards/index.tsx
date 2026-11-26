/** 卡牌工坊：完整对接 LecPunch /cards/* 接口（单抽/十连、保底进度、卡池图鉴、背包使用与赠送、互动收件箱）。 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  Button,
  Card,
  Dialog,
  Empty,
  Message,
  SegmentedControl,
  Tag,
} from '@lec-space/liquidglass';
import { Gift, Shield, Sparkles, Wand2 } from 'lucide-react';
import type {
  CardCollectionItem,
  CardGameActionResult,
  CardRarity,
} from '@shared/punch';
import { formatReadableDuration } from '@shared/punch';
import { notifyToast } from '@/services/orbitToast';
import { punchApi } from '@/services/punchApi';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchCards.module.css';

type CardsTab = 'inventory' | 'catalog' | 'events';
type RarityFilter = 'ALL' | CardRarity;

const RARITY_LABEL: Record<CardRarity, string> = {
  SSR: 'SSR · 传说',
  SR: 'SR · 史诗',
  R: 'R · 稀有',
  N: 'N · 常规',
};

const RARITY_ORDER: Record<CardRarity, number> = {
  SSR: 0,
  SR: 1,
  R: 2,
  N: 3,
};

function CardArtwork({
  cardId,
  unlocked,
  rarity,
  alt,
}: {
  cardId: string;
  unlocked: boolean;
  rarity: CardRarity;
  alt: string;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(() =>
    unlocked ? punchApi.getCachedCardArtUrl(cardId) : null,
  );

  useEffect(() => {
    if (!unlocked) return;
    const cached = punchApi.getCachedCardArtUrl(cardId);
    if (cached) {
      setSrc(cached);
      return;
    }
    const controller = new AbortController();
    void punchApi
      .fetchCardArtUrl(cardId, controller.signal)
      .then(setSrc)
      .catch(() => undefined);
    return () => controller.abort();
  }, [cardId, unlocked]);

  if (!unlocked) {
    return (
      <div className={`${styles.artPlaceholder} ${styles[`rarityBg${rarity}`]}`}>
        <Sparkles size={26} className={styles.lockedIcon} />
        <span className={styles.lockedText}>尚未发现</span>
      </div>
    );
  }

  return (
    <div className={`${styles.artFrame} ${styles[`rarityBg${rarity}`]}`}>
      {src ? (
        <img src={src} alt={alt} className={styles.artImg} loading="lazy" />
      ) : (
        <div className={styles.artShimmer} />
      )}
    </div>
  );
}

export function PunchCardsPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const game = useOrbitStore((s) => s.cardGame);
  const error = useOrbitStore((s) => s.cardGameError);
  const setGame = useOrbitStore((s) => s.setCardGame);
  const refreshCardGame = useOrbitStore((s) => s.refreshCardGame);
  const setLoginModalOpen = useOrbitStore((s) => s.setLoginModalOpen);

  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [tab, setTab] = useState<CardsTab>('inventory');
  const [rarityFilter, setRarityFilter] = useState<RarityFilter>('ALL');

  const [selectedCard, setSelectedCard] = useState<CardCollectionItem | null>(null);
  const [actionMode, setActionMode] = useState<'use' | 'gift'>('use');
  const [targetId, setTargetId] = useState('');
  const [secondTargetId, setSecondTargetId] = useState('');

  const [actionResult, setActionResult] = useState<CardGameActionResult | null>(null);

  useEffect(() => {
    if (!auth.authenticated) return;
    if (!game) {
      void refreshCardGame({ silent: false });
    }
  }, [auth.authenticated, game, refreshCardGame]);

  const cardById = useMemo(() => {
    const map = new Map<string, CardCollectionItem>();
    for (const item of game?.collection ?? []) {
      map.set(item.id, item);
    }
    return map;
  }, [game]);

  const sortedCollection = useMemo(() => {
    const list = [...(game?.collection ?? [])];
    list.sort((a, b) => {
      const r = RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity];
      if (r !== 0) return r;
      if (a.quantity !== b.quantity) return b.quantity - a.quantity;
      return a.id.localeCompare(b.id);
    });
    return list;
  }, [game]);

  const visibleCards = useMemo(() => {
    return sortedCollection.filter((item) => {
      if (tab === 'inventory' && item.quantity <= 0) return false;
      if (rarityFilter !== 'ALL' && item.rarity !== rarityFilter) return false;
      return true;
    });
  }, [sortedCollection, tab, rarityFilter]);

  const totalOwned = useMemo(
    () => (game?.collection ?? []).reduce((sum, item) => sum + item.quantity, 0),
    [game],
  );
  const discoveredCount = useMemo(
    () => (game?.collection ?? []).filter((item) => item.unlocked).length,
    [game],
  );

  const handleDraw = async (count: 1 | 10) => {
    if (busyAction) return;
    setBusyAction(`draw-${count}`);
    try {
      const res = await punchApi.performCardAction({
        requestKey: crypto.randomUUID(),
        action: 'draw',
        count,
      });
      setGame(res.state);
      setActionResult(res.result);
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: count === 10 ? '十连抽卡失败' : '单抽失败',
        description: err instanceof Error ? err.message : '请检查积分或网络后重试。',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const openCardModal = (card: CardCollectionItem) => {
    setSelectedCard(card);
    setActionMode(card.usable !== false ? 'use' : 'gift');
    setTargetId('');
    setSecondTargetId('');
  };

  const handleExecuteCardAction = async () => {
    if (!selectedCard || busyAction) return;
    if (actionMode === 'gift' && !targetId) {
      notifyToast({ tone: 'error', title: '请选择受赠队友' });
      return;
    }
    if (
      actionMode === 'use' &&
      (selectedCard.targetMode === 'other' ||
        selectedCard.targetMode === 'self-or-other' ||
        selectedCard.targetMode === 'recipient') &&
      !targetId
    ) {
      notifyToast({ tone: 'error', title: '请选择目标成员' });
      return;
    }
    if (actionMode === 'use' && selectedCard.targetMode === 'two' && (!targetId || !secondTargetId)) {
      notifyToast({ tone: 'error', title: '请选择两名目标成员' });
      return;
    }

    setBusyAction(actionMode);
    try {
      const res = await punchApi.performCardAction({
        requestKey: crypto.randomUUID(),
        action: actionMode,
        cardId: selectedCard.id,
        targetId: targetId || undefined,
        secondTargetId: secondTargetId || undefined,
      });
      setGame(res.state);
      setSelectedCard(null);
      setActionResult(res.result);
      notifyToast({
        tone: 'success',
        title: actionMode === 'gift' ? '已送出卡牌' : '卡牌发动成功',
        description: res.result.message,
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: actionMode === 'gift' ? '赠送失败' : '使用卡牌失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleAckAllInbox = async () => {
    if (!game) return;
    const giftIds = (game.incomingGifts ?? []).map((g) => g.id);
    const defenseIds = (game.incomingDefenses ?? []).map((d) => d.id);
    const interactionIds = (game.incomingInteractions ?? []).map((i) => i.id);
    try {
      await Promise.all([
        punchApi.acknowledgeCardGifts(giftIds),
        punchApi.acknowledgeCardDefenses(defenseIds),
        punchApi.acknowledgeCardInteractions(interactionIds),
      ]);
      setGame({
        ...game,
        incomingGifts: [],
        incomingDefenses: [],
        incomingInteractions: [],
      });
      notifyToast({ tone: 'success', title: '已确认全部卡牌互动消息' });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '确认失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  };

  const gainedCards = useMemo(() => {
    if (!actionResult) return [];
    const ids = actionResult.gainedCardIds?.length
      ? actionResult.gainedCardIds
      : actionResult.gainedCardId
        ? [actionResult.gainedCardId]
        : [];
    return ids.map((id) => cardById.get(id)).filter((c): c is CardCollectionItem => Boolean(c));
  }, [actionResult, cardById]);

  if (!auth.authenticated) {
    return (
      <div className={styles.page}>
        <Empty
          title="登录后开启卡牌工坊"
          description="登录后即可抽取、收集并向队友发动本周考勤卡牌。"
        >
          <Button variant="filled" onClick={() => setLoginModalOpen(true)}>
            立即登录
          </Button>
        </Empty>
      </div>
    );
  }

  const inboxCount =
    (game?.incomingGifts?.length ?? 0) +
    (game?.incomingDefenses?.length ?? 0) +
    (game?.incomingInteractions?.length ?? 0);

  const needsTarget =
    actionMode === 'gift' ||
    (selectedCard?.targetMode !== undefined && selectedCard.targetMode !== 'none');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>卡牌工坊</h1>
          <p className={styles.subtitle}>
            {game
              ? `当前周次 ${game.week} · 已收集 ${discoveredCount}/${game.collection.length} 种 · 背包持有 ${totalOwned} 张`
              : '同步 LecPunch 卡牌池、保底进度与队友互动'}
          </p>
        </div>
      </header>

      {error && <Message tone="error">{error}</Message>}

      {!game && !error && (
        <div className={styles.skeletonWrap} aria-busy="true">
          <div className={styles.skeletonHero} />
          <div className={styles.cardGrid}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={styles.skeletonCard} />
            ))}
          </div>
        </div>
      )}

      {game && (
        <>
          <Card className={styles.heroCard}>
            <div className={styles.heroStats}>
              <div className={styles.statBlock}>
                <span className={styles.statLabel}>
                  {game.points.rule === 'unified-coin-v2' ? '可用乐币' : '可用积分'}
                </span>
                <strong className={styles.statValue}>{game.points.balance}</strong>
                <span className={styles.statHint}>
                  本周累计 {game.points.earned} · 已消费 {game.points.spent}
                  {typeof game.coinCostPerDraw === 'number' ? ` · ${game.coinCostPerDraw} 乐币/抽` : ''}
                </span>
              </div>
              <div className={styles.statBlock}>
                <span className={styles.statLabel}>免费 / 赠礼次数</span>
                <strong className={styles.statValue}>
                  {game.freeRemaining + game.giftDraws}
                </strong>
                <span className={styles.statHint}>
                  免费 {game.freeRemaining} 次 · 赠礼 {game.giftDraws} 次
                  {typeof game.weeklyPaidDrawsLimit === 'number'
                    ? ` · 付费已用 ${game.weeklyPaidDrawsUsed ?? 0}/${game.weeklyPaidDrawsLimit}`
                    : ''}
                </span>
              </div>
              <div className={styles.statBlock}>
                <span className={styles.statLabel}>保底进度</span>
                <div className={styles.pityRow}>
                  <Tag tone="info">距 SR 还差 {game.pity.srRemaining} 抽</Tag>
                  <Tag tone="warning">距 SSR 还差 {game.pity.ssrRemaining} 抽</Tag>
                </div>
                <span className={styles.statHint}>
                  娱乐时长：{formatReadableDuration(game.entertainmentSeconds)}
                </span>
              </div>
            </div>

            <div className={styles.drawActions}>
              <Button
                variant="glass"
                icon={<Sparkles size={15} />}
                loading={busyAction === 'draw-1'}
                disabled={Boolean(busyAction)}
                onClick={() => void handleDraw(1)}
              >
                单抽一次
              </Button>
              <Button
                variant="filled"
                icon={<Sparkles size={15} />}
                loading={busyAction === 'draw-10'}
                disabled={Boolean(busyAction)}
                onClick={() => void handleDraw(10)}
              >
                十连抽卡
              </Button>
            </div>
          </Card>

          {(game.statuses.acceleration ||
            game.statuses.immuneUntil ||
            game.statuses.lockedUntil ||
            game.statuses.starvedUntil) && (
            <div className={styles.statusStrip}>
              {game.statuses.acceleration && <Tag tone="success">加速 Buff 生效中</Tag>}
              {game.statuses.immuneUntil && <Tag tone="info">免疫护盾至 {game.statuses.immuneUntil}</Tag>}
              {game.statuses.lockedUntil && <Tag tone="warning">锁定状态至 {game.statuses.lockedUntil}</Tag>}
              {game.statuses.starvedUntil && <Tag tone="danger">饥饿状态至 {game.statuses.starvedUntil}</Tag>}
            </div>
          )}

          {inboxCount > 0 && (
            <Card className={styles.inboxCard}>
              <div className={styles.inboxHeader}>
                <div className={styles.inboxTitle}>
                  <Shield size={16} />
                  <span>收到 {inboxCount} 条新的卡牌互动</span>
                </div>
                <Button variant="filled" size="small" onClick={() => void handleAckAllInbox()}>
                  全部确认
                </Button>
              </div>
              <div className={styles.inboxList}>
                {(game.incomingGifts ?? []).map((g) => (
                  <div key={g.id} className={styles.inboxItem}>
                    <Tag tone="success">赠卡</Tag>
                    <span>
                      <strong>{g.sender.displayName}</strong> 赠送了【{g.card.rarity} · {g.card.name}】
                    </span>
                  </div>
                ))}
                {(game.incomingDefenses ?? []).map((d) => (
                  <div key={d.id} className={styles.inboxItem}>
                    <Tag tone="info">防御</Tag>
                    <span>
                      {d.events
                        .map(
                          (e) =>
                            `${e.attacker.displayName} 的「${e.attackCard.name}」被你的「${e.defenseCard.name}」${
                              e.outcome === 'reflected' ? '反弹' : '抵挡'
                            }`,
                        )
                        .join('；')}
                    </span>
                  </div>
                ))}
                {(game.incomingInteractions ?? []).map((i) => (
                  <div key={i.id} className={styles.inboxItem}>
                    <Tag tone="warning">互动</Tag>
                    <span>
                      <strong>{i.sender.displayName}</strong> 对你发动了【{i.card.rarity} · {i.card.name}】
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div className={styles.toolbar}>
            <SegmentedControl
              value={tab}
              onValueChange={(v) => setTab(v as CardsTab)}
              items={[
                { value: 'inventory', label: `我的背包 (${totalOwned})` },
                { value: 'catalog', label: `全部图鉴 (${discoveredCount}/${game.collection.length})` },
                { value: 'events', label: `近期动态 (${game.events.length})` },
              ]}
            />
            {tab !== 'events' && (
              <SegmentedControl
                value={rarityFilter}
                onValueChange={(v) => setRarityFilter(v as RarityFilter)}
                items={[
                  { value: 'ALL', label: '全部' },
                  { value: 'SSR', label: 'SSR' },
                  { value: 'SR', label: 'SR' },
                  { value: 'R', label: 'R' },
                  { value: 'N', label: 'N' },
                ]}
              />
            )}
          </div>

          {tab === 'events' ? (
            <Card className={styles.eventsCard}>
              {game.events.length === 0 ? (
                <Empty title="本周暂无卡牌动态" description="抽到第一张卡牌或发动效果后会记录在这里。" />
              ) : (
                <div className={styles.eventList}>
                  {game.events.map((ev) => (
                    <div key={ev.id} className={styles.eventRow}>
                      <span className={styles.eventMsg}>{ev.message}</span>
                      <span className={styles.eventTime}>
                        {new Date(ev.at).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ) : visibleCards.length === 0 ? (
            <Card>
              <Empty
                title={tab === 'inventory' ? '背包里还没有这类卡牌' : '暂无匹配图鉴'}
                description="点击上方「单抽一次」或「十连抽卡」试试手气吧。"
              />
            </Card>
          ) : (
            <div className={styles.cardGrid}>
              {visibleCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className={`${styles.cardTile} ${styles[`rarityBorder${card.rarity}`]} ${
                    !card.unlocked ? styles.cardTileLocked : ''
                  }`}
                  onClick={() => card.unlocked && openCardModal(card)}
                >
                  <CardArtwork
                    cardId={card.id}
                    unlocked={card.unlocked}
                    rarity={card.rarity}
                    alt={card.name ?? card.id}
                  />
                  <div className={styles.cardMeta}>
                    <div className={styles.cardMetaTop}>
                      <span className={`${styles.rarityChip} ${styles[`rarityChip${card.rarity}`]}`}>
                        {card.rarity}
                      </span>
                      {card.quantity > 0 && <span className={styles.qtyBadge}>×{card.quantity}</span>}
                    </div>
                    <div className={styles.cardName}>{card.unlocked ? card.name : '未解锁卡牌'}</div>
                    <div className={styles.cardSummary}>
                      {card.unlocked ? card.summary || card.effect || '点击查看详情' : '抽中后点亮图鉴'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* 卡牌详情与使用/赠送弹窗 */}
      <Dialog
        open={Boolean(selectedCard)}
        onOpenChange={(open) => !open && setSelectedCard(null)}
        size="regular"
        title={selectedCard ? `${selectedCard.name ?? selectedCard.id} · ${RARITY_LABEL[selectedCard.rarity]}` : '卡牌详情'}
        description={selectedCard?.type ? `类型：${selectedCard.type} · 当前持有 ×${selectedCard.quantity}` : undefined}
      >
        {selectedCard && (
          <div className={styles.detailModal}>
            <div className={styles.detailHero}>
              <div className={styles.detailArtWrap}>
                <CardArtwork
                  cardId={selectedCard.id}
                  unlocked={selectedCard.unlocked}
                  rarity={selectedCard.rarity}
                  alt={selectedCard.name ?? selectedCard.id}
                />
              </div>
              <div className={styles.detailBody}>
                {selectedCard.stat && <Tag tone="info">{selectedCard.stat}</Tag>}
                <p className={styles.detailEffect}>{selectedCard.effect || selectedCard.summary}</p>
                {selectedCard.detail && <p className={styles.detailDesc}>{selectedCard.detail}</p>}
              </div>
            </div>

            {selectedCard.quantity > 0 && (
              <div className={styles.detailActionsBox}>
                <SegmentedControl
                  value={actionMode}
                  onValueChange={(v) => {
                    setActionMode(v as 'use' | 'gift');
                    setTargetId('');
                    setSecondTargetId('');
                  }}
                  items={[
                    ...(selectedCard.usable !== false
                      ? [{ value: 'use', label: '使用卡牌' }]
                      : []),
                    { value: 'gift', label: '赠送给队友' },
                  ]}
                />

                {needsTarget && (
                  <div className={styles.selectRow}>
                    <label className={styles.selectField}>
                      <span>{actionMode === 'gift' ? '选择受赠队友' : '选择目标成员'}</span>
                      <select
                        className={styles.select}
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                      >
                        <option value="">请选择成员…</option>
                        {(game?.players ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}（@{p.username} · {p.enrollYear}级）
                          </option>
                        ))}
                      </select>
                    </label>
                    {actionMode === 'use' && selectedCard.targetMode === 'two' && (
                      <label className={styles.selectField}>
                        <span>第二目标成员</span>
                        <select
                          className={styles.select}
                          value={secondTargetId}
                          onChange={(e) => setSecondTargetId(e.target.value)}
                        >
                          <option value="">请选择第二目标…</option>
                          {(game?.players ?? [])
                            .filter((p) => p.id !== targetId)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.displayName}（@{p.username}）
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}

                <div className={styles.detailFooter}>
                  <Button variant="glass" size="small" onClick={() => setSelectedCard(null)}>
                    关闭
                  </Button>
                  <Button
                    variant="filled"
                    size="small"
                    icon={actionMode === 'gift' ? <Gift size={14} /> : <Wand2 size={14} />}
                    loading={Boolean(busyAction)}
                    onClick={() => void handleExecuteCardAction()}
                  >
                    {actionMode === 'gift' ? '确认赠送' : '发动卡牌'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* 抽卡 / 发动结果弹窗 */}
      <Dialog
        open={Boolean(actionResult)}
        onOpenChange={(open) => !open && setActionResult(null)}
        size={gainedCards.length > 1 ? 'large' : 'small'}
        title={actionResult?.drawCount === 10 ? '十连抽卡结果' : '操作结果'}
        description={actionResult?.message}
      >
        {actionResult && (
          <div className={styles.resultBody}>
            {gainedCards.length > 0 && (
              <div
                className={
                  gainedCards.length > 1 ? styles.resultGridTen : styles.resultSingleWrap
                }
              >
                {gainedCards.map((card, idx) => (
                  <div
                    key={`${card.id}-${idx}`}
                    className={`${styles.resultCard} ${styles[`rarityBorder${card.rarity}`]}`}
                  >
                    <CardArtwork
                      cardId={card.id}
                      unlocked
                      rarity={card.rarity}
                      alt={card.name ?? card.id}
                    />
                    <div className={styles.resultCardMeta}>
                      <span className={`${styles.rarityChip} ${styles[`rarityChip${card.rarity}`]}`}>
                        {card.rarity}
                      </span>
                      <span className={styles.resultCardName}>{card.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {actionResult.effects && actionResult.effects.length > 0 && (
              <div className={styles.effectList}>
                {actionResult.effects.map((ef, idx) => (
                  <div key={idx} className={styles.effectRow}>
                    <Tag tone={ef.outcome === 'applied' ? 'success' : 'warning'}>{ef.outcome}</Tag>
                    <span>
                      目标 <strong>{ef.actualTarget?.displayName ?? ef.target.displayName}</strong>
                      {ef.detail ? `：${ef.detail}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.detailFooter}>
              <Button variant="filled" size="small" onClick={() => setActionResult(null)}>
                太棒了
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
