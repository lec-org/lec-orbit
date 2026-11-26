/**
 * 底层资产账本服务（唯一真相源 · PostgreSQL 事务 + 字典序行锁 + 零和校验）：
 * - 负责 economy_accounts / economy_holds / economy_ledger_entries 的强一致写入；
 * - 任何涉及多人的写事务均按 userId 字典序升序加 SELECT ... FOR UPDATE 行锁，彻底防死锁；
 * - 严禁向工坊外部接口暴露铸币方法，mintCoins 仅限内部服务总线与队长发奖使用。
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { getShanghaiDayBounds, getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { EconomyAccountEntity } from './entities/economy-account.entity.js';
import { EconomyHoldEntity, type EconomyAsset } from './entities/economy-hold.entity.js';
import {
  EconomyLedgerEntryEntity,
  type EconomyLedgerReason,
} from './entities/economy-ledger-entry.entity.js';
import {
  assertZeroSumInvariant,
  computeBurnAndNetPayout,
  type InternalMintInput,
  type InternalSpendInput,
  type WalletSummaryDTO,
} from './economy.types.js';

@Injectable()
export class EconomyLedgerService {
  private readonly mergedLegacyPairs = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * 幂等合并历史迁移账户（punch_users.id -> ssoSub）：
   * 若成员在 MongoDB 迁移时未绑定 logtoUserId，期初乐币会暂存在 legacyUserId 下；
   * 成员后续经 LecSSO 登录绑定 ssoSub 时，在同一事务内按字典序加锁将其余额、累计荣誉值与本周真实打卡分钟数原子转入 canonicalUserId。
   */
  async mergeLegacyAccountIfNeeded(
    legacyUserId: string,
    canonicalUserId: string,
  ): Promise<{ mergedCoins: number }> {
    const fromId = legacyUserId.trim();
    const toId = canonicalUserId.trim();
    if (!fromId || !toId || fromId === toId) {
      return { mergedCoins: 0 };
    }
    const pairKey = `${fromId}->${toId}`;
    if (this.mergedLegacyPairs.has(pairKey)) {
      return { mergedCoins: 0 };
    }

    const legacy = await this.dataSource
      .getRepository(EconomyAccountEntity)
      .findOne({ where: { userId: fromId } });
    if (
      !legacy ||
      (legacy.coinBalance <= 0 &&
        legacy.lifetimeEarnedCoins <= 0 &&
        legacy.weeklyRecordedMinutes <= 0)
    ) {
      if (this.mergedLegacyPairs.size > 2000) this.mergedLegacyPairs.clear();
      this.mergedLegacyPairs.add(pairKey);
      return { mergedCoins: 0 };
    }

    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const mergedCoins = await this.dataSource.transaction(async (manager) => {
      const accounts = await this.lockAccountsTx(manager, [fromId, toId], now);
      const fromAcc = accounts.get(fromId)!;
      const toAcc = accounts.get(toId)!;

      const moveCoins = Math.max(0, fromAcc.coinBalance);
      const moveLifetime = Math.max(0, fromAcc.lifetimeEarnedCoins);
      const moveWeekMinutes =
        fromAcc.weeklyRecordedWeekKey === weekKey ? Math.max(0, fromAcc.weeklyRecordedMinutes) : 0;

      if (moveCoins === 0 && moveLifetime === 0 && moveWeekMinutes === 0) {
        return 0;
      }

      fromAcc.coinBalance -= moveCoins;
      fromAcc.lifetimeEarnedCoins -= moveLifetime;
      if (moveWeekMinutes > 0) {
        fromAcc.weeklyRecordedMinutes = 0;
        const currentToMinutes =
          toAcc.weeklyRecordedWeekKey === weekKey ? toAcc.weeklyRecordedMinutes : 0;
        toAcc.weeklyRecordedMinutes = Math.max(currentToMinutes, moveWeekMinutes);
        toAcc.weeklyRecordedWeekKey = weekKey;
      }
      toAcc.coinBalance += moveCoins;
      toAcc.lifetimeEarnedCoins += moveLifetime;
      fromAcc.updatedAt = now;
      toAcc.updatedAt = now;
      await manager.save(EconomyAccountEntity, [fromAcc, toAcc]);

      if (moveCoins > 0) {
        const txGroupId = randomUUID();
        const mergeKeyBase = `migration:merge-account:${fromId}:${toId}:${txGroupId}`;
        await manager.save(EconomyLedgerEntryEntity, [
          manager.create(EconomyLedgerEntryEntity, {
            entryId: randomUUID(),
            txGroupId,
            orderId: null,
            appId: 'lec-punch-migration',
            userId: fromId,
            counterpartyUserId: toId,
            asset: 'coin',
            delta: -moveCoins,
            countsTowardLifetime: false,
            weekKey,
            reason: 'migration_init',
            title: '历史迁移乐币账户合并转出',
            idempotencyKey: `${mergeKeyBase}:out`,
            createdAt: now,
          }),
          manager.create(EconomyLedgerEntryEntity, {
            entryId: randomUUID(),
            txGroupId,
            orderId: null,
            appId: 'lec-punch-migration',
            userId: toId,
            counterpartyUserId: fromId,
            asset: 'coin',
            delta: moveCoins,
            countsTowardLifetime: false,
            weekKey,
            reason: 'migration_init',
            title: '历史迁移乐币账户合并转入',
            idempotencyKey: `${mergeKeyBase}:in`,
            createdAt: now,
          }),
        ]);
      }

      return moveCoins;
    });

    if (this.mergedLegacyPairs.size > 2000) this.mergedLegacyPairs.clear();
    this.mergedLegacyPairs.add(pairKey);
    return { mergedCoins };
  }

  /**
   * 事务内按 userId 字典序升序确保账户行存在并加悲观写锁（SELECT ... FOR UPDATE）。
   * 确定性加锁顺序可 100% 避免双人并发互有胜负结算引发 PostgreSQL 死锁。
   */
  async lockAccountsTx(
    manager: EntityManager,
    rawUserIds: string[],
    now: Date,
  ): Promise<Map<string, EconomyAccountEntity>> {
    const sortedIds = [...new Set(rawUserIds.filter((id) => id.trim().length > 0))].sort();
    if (sortedIds.length === 0) {
      return new Map();
    }

    for (const userId of sortedIds) {
      await manager.query(
        `INSERT INTO economy_accounts (user_id, coin_balance, frozen_coins, lifetime_earned_coins, weekly_recorded_minutes, weekly_recorded_week_key, updated_at)
         VALUES ($1, 0, 0, 0, 0, '', $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, now],
      );
    }

    const rows = await manager
      .createQueryBuilder(EconomyAccountEntity, 'acc')
      .setLock('pessimistic_write')
      .where('acc.user_id IN (:...ids)', { ids: sortedIds })
      .orderBy('acc.user_id', 'ASC')
      .getMany();

    const map = new Map<string, EconomyAccountEntity>();
    for (const row of rows) {
      map.set(row.userId, row);
    }
    return map;
  }

  /** 在外部事务内冻结单人资产（按 idempotencyKey 强幂等）。 */
  async createHoldTx(
    manager: EntityManager,
    input: {
      orderId: string;
      appId: string;
      userId: string;
      asset: EconomyAsset;
      amount: number;
      weekKey: string;
      expiresAt: Date;
      idempotencyKey: string;
    },
    now: Date,
  ): Promise<EconomyHoldEntity> {
    const existing = await manager.findOne(EconomyHoldEntity, {
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return existing;
    }

    const accounts = await this.lockAccountsTx(manager, [input.userId], now);
    const acc = accounts.get(input.userId)!;

    if (input.asset === 'coin') {
      if (acc.coinBalance < input.amount) {
        throw new BadRequestException(
          `当前可用乐币不足（需要 ${input.amount}，可用 ${acc.coinBalance}）`,
        );
      }
      acc.coinBalance -= input.amount;
      acc.frozenCoins += input.amount;
      acc.updatedAt = now;
      await manager.save(EconomyAccountEntity, acc);
    }

    const hold = manager.create(EconomyHoldEntity, {
      holdId: randomUUID(),
      orderId: input.orderId,
      appId: input.appId,
      userId: input.userId,
      asset: input.asset,
      amount: input.amount,
      weekKey: input.weekKey,
      status: 'active',
      expiresAt: input.expiresAt,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    await manager.save(EconomyHoldEntity, hold);
    return hold;
  }

  /** 在外部事务内解冻单个冻结单（已 released 幂等返回；已 captured 抛冲突）。 */
  async releaseHoldTx(manager: EntityManager, holdId: string, now: Date): Promise<void> {
    const hold = await manager
      .createQueryBuilder(EconomyHoldEntity, 'h')
      .setLock('pessimistic_write')
      .where('h.hold_id = :holdId', { holdId })
      .getOne();

    if (!hold || hold.status === 'released') {
      return;
    }
    if (hold.status === 'captured') {
      throw new ConflictException('冻结单已被结算划转，无法解冻');
    }

    if (hold.asset === 'coin') {
      const accounts = await this.lockAccountsTx(manager, [hold.userId], now);
      const acc = accounts.get(hold.userId)!;
      const refund = Math.min(hold.amount, acc.frozenCoins);
      acc.frozenCoins -= refund;
      acc.coinBalance += refund;
      acc.updatedAt = now;
      await manager.save(EconomyAccountEntity, acc);
    }

    hold.status = 'released';
    hold.updatedAt = now;
    await manager.save(EconomyHoldEntity, hold);
  }

  /**
   * 事务内原子结算双人托管赌约（严格校验零和守恒 + 字典序加锁 + 幂等流水）：
   * - coin：解冻赢家本金 + 划转输家冻结本金（扣除可选燃烧税）给赢家，写入 +netWin / -amount 流水；
   * - punch_minutes：标记双方冻结单 captured，写入 +amount / -amount 娱乐时长流水（严禁燃烧时长）。
   */
  async settleEscrowWagerTx(
    manager: EntityManager,
    input: {
      orderId: string;
      appId: string;
      title: string;
      asset: EconomyAsset;
      amount: number;
      weekKey: string;
      winnerUserId: string;
      loserUserId: string;
      winnerHoldId: string | null;
      loserHoldId: string | null;
    },
    now: Date,
  ): Promise<{ txGroupId: string; winnerNetDelta: number; loserDelta: number; burnAmount: number }> {
    const { netWin, burnAmount } = computeBurnAndNetPayout(
      input.asset,
      input.amount,
      this.cfg.economy.burnRateBps,
    );

    const legs = [
      { userId: input.winnerUserId, delta: netWin },
      { userId: input.loserUserId, delta: -input.amount },
    ];
    // 数学硬校验：确保绝不凭空增发任何币或时长
    assertZeroSumInvariant(legs, burnAmount);

    // 字典序加锁双方账户，杜绝死锁
    const accounts = await this.lockAccountsTx(
      manager,
      [input.winnerUserId, input.loserUserId],
      now,
    );

    // 按 holdId 排序锁定双方冻结单
    const holdIds = [input.winnerHoldId, input.loserHoldId]
      .filter((id): id is string => Boolean(id))
      .sort();
    const holds = holdIds.length
      ? await manager
          .createQueryBuilder(EconomyHoldEntity, 'h')
          .setLock('pessimistic_write')
          .where('h.hold_id IN (:...ids)', { ids: holdIds })
          .orderBy('h.hold_id', 'ASC')
          .getMany()
      : [];

    for (const hold of holds) {
      if (hold.status !== 'active') {
        throw new ConflictException('冻结单状态异常，无法重复结算');
      }
      hold.status = 'captured';
      hold.updatedAt = now;
      await manager.save(EconomyHoldEntity, hold);
    }

    if (input.asset === 'coin') {
      const winnerAcc = accounts.get(input.winnerUserId)!;
      const loserAcc = accounts.get(input.loserUserId)!;
      winnerAcc.frozenCoins = Math.max(0, winnerAcc.frozenCoins - input.amount);
      loserAcc.frozenCoins = Math.max(0, loserAcc.frozenCoins - input.amount);
      // 赢家拿回自己解冻的本金 + 赢得的净筹码
      winnerAcc.coinBalance += input.amount + netWin;
      winnerAcc.updatedAt = now;
      loserAcc.updatedAt = now;
      await manager.save(EconomyAccountEntity, [winnerAcc, loserAcc]);
    }

    const txGroupId = randomUUID();
    const entries: EconomyLedgerEntryEntity[] = [
      manager.create(EconomyLedgerEntryEntity, {
        entryId: randomUUID(),
        txGroupId,
        orderId: input.orderId,
        appId: input.appId,
        userId: input.winnerUserId,
        counterpartyUserId: input.loserUserId,
        asset: input.asset,
        delta: netWin,
        countsTowardLifetime: false, // P2P 赌约互赢绝不虚增累计荣誉值
        weekKey: input.weekKey,
        reason: 'wager_win',
        title: input.title,
        idempotencyKey: `settle:${input.orderId}:${input.winnerUserId}:win`,
        createdAt: now,
      }),
      manager.create(EconomyLedgerEntryEntity, {
        entryId: randomUUID(),
        txGroupId,
        orderId: input.orderId,
        appId: input.appId,
        userId: input.loserUserId,
        counterpartyUserId: input.winnerUserId,
        asset: input.asset,
        delta: -input.amount,
        countsTowardLifetime: false,
        weekKey: input.weekKey,
        reason: 'wager_loss',
        title: input.title,
        idempotencyKey: `settle:${input.orderId}:${input.loserUserId}:loss`,
        createdAt: now,
      }),
    ];

    if (burnAmount > 0) {
      entries.push(
        manager.create(EconomyLedgerEntryEntity, {
          entryId: randomUUID(),
          txGroupId,
          orderId: input.orderId,
          appId: input.appId,
          userId: '__burn_sink__',
          counterpartyUserId: input.winnerUserId,
          asset: 'coin',
          delta: burnAmount,
          countsTowardLifetime: false,
          weekKey: input.weekKey,
          reason: 'burn_fee',
          title: `燃烧税：${input.title}`,
          idempotencyKey: `settle:${input.orderId}:burn`,
          createdAt: now,
        }),
      );
    }

    await manager.save(EconomyLedgerEntryEntity, entries);

    return {
      txGroupId,
      winnerNetDelta: netWin,
      loserDelta: -input.amount,
      burnAmount,
    };
  }

  /** 成员间即时打赏（coin 零和划转，带可选燃烧税）。 */
  async transferCoinTx(
    manager: EntityManager,
    input: {
      orderId: string;
      appId: string;
      fromUserId: string;
      toUserId: string;
      amount: number;
      title: string;
      weekKey: string;
    },
    now: Date,
  ): Promise<{ txGroupId: string; netReceived: number; burnAmount: number }> {
    if (input.fromUserId === input.toUserId) {
      throw new BadRequestException('不能给自己打赏');
    }
    const { netWin: netReceived, burnAmount } = computeBurnAndNetPayout(
      'coin',
      input.amount,
      this.cfg.economy.burnRateBps,
    );
    assertZeroSumInvariant(
      [
        { userId: input.toUserId, delta: netReceived },
        { userId: input.fromUserId, delta: -input.amount },
      ],
      burnAmount,
    );

    const accounts = await this.lockAccountsTx(manager, [input.fromUserId, input.toUserId], now);
    const fromAcc = accounts.get(input.fromUserId)!;
    const toAcc = accounts.get(input.toUserId)!;

    if (fromAcc.coinBalance < input.amount) {
      throw new BadRequestException(
        `当前可用乐币不足（需要 ${input.amount}，可用 ${fromAcc.coinBalance}）`,
      );
    }
    fromAcc.coinBalance -= input.amount;
    toAcc.coinBalance += netReceived;
    fromAcc.updatedAt = now;
    toAcc.updatedAt = now;
    await manager.save(EconomyAccountEntity, [fromAcc, toAcc]);

    const txGroupId = randomUUID();
    const entries: EconomyLedgerEntryEntity[] = [
      manager.create(EconomyLedgerEntryEntity, {
        entryId: randomUUID(),
        txGroupId,
        orderId: input.orderId,
        appId: input.appId,
        userId: input.fromUserId,
        counterpartyUserId: input.toUserId,
        asset: 'coin',
        delta: -input.amount,
        countsTowardLifetime: false,
        weekKey: input.weekKey,
        reason: 'tip_out',
        title: input.title,
        idempotencyKey: `tip:${input.orderId}:${input.fromUserId}:out`,
        createdAt: now,
      }),
      manager.create(EconomyLedgerEntryEntity, {
        entryId: randomUUID(),
        txGroupId,
        orderId: input.orderId,
        appId: input.appId,
        userId: input.toUserId,
        counterpartyUserId: input.fromUserId,
        asset: 'coin',
        delta: netReceived,
        countsTowardLifetime: false,
        weekKey: input.weekKey,
        reason: 'tip_in',
        title: input.title,
        idempotencyKey: `tip:${input.orderId}:${input.toUserId}:in`,
        createdAt: now,
      }),
    ];
    await manager.save(EconomyLedgerEntryEntity, entries);
    return { txGroupId, netReceived, burnAmount };
  }

  /**
   * 仅限内部服务总线（LecPunch 打卡签退 / 狂热加成 / 存量迁移）与队长发奖使用的铸币接口。
   * 严格按 idempotencyKey 幂等，且计入 lifetimeEarnedCoins。
   */
  async mintCoins(input: InternalMintInput): Promise<{
    alreadyProcessed: boolean;
    coinBalance: number;
    lifetimeEarnedCoins: number;
  }> {
    const now = new Date();
    const weekKey = input.weekKey?.trim() || getShanghaiWeekKey(now);

    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(EconomyLedgerEntryEntity, {
        where: { idempotencyKey: input.idempotencyKey },
      });
      const accounts = await this.lockAccountsTx(manager, [input.userId], now);
      const acc = accounts.get(input.userId)!;

      if (input.weeklyRecordedMinutes !== undefined) {
        acc.weeklyRecordedMinutes = input.weeklyRecordedMinutes;
        acc.weeklyRecordedWeekKey = weekKey;
        acc.updatedAt = now;
      }

      if (existing) {
        if (input.weeklyRecordedMinutes !== undefined) {
          await manager.save(EconomyAccountEntity, acc);
        }
        return {
          alreadyProcessed: true,
          coinBalance: acc.coinBalance,
          lifetimeEarnedCoins: acc.lifetimeEarnedCoins,
        };
      }

      acc.coinBalance += input.amount;
      acc.lifetimeEarnedCoins += input.amount;
      acc.updatedAt = now;
      await manager.save(EconomyAccountEntity, acc);

      const entry = manager.create(EconomyLedgerEntryEntity, {
        entryId: randomUUID(),
        txGroupId: randomUUID(),
        orderId: null,
        appId: input.appId,
        userId: input.userId,
        counterpartyUserId: null,
        asset: 'coin',
        delta: input.amount,
        countsTowardLifetime: true,
        weekKey,
        reason: input.reason as EconomyLedgerReason,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      });
      await manager.save(EconomyLedgerEntryEntity, entry);

      return {
        alreadyProcessed: false,
        coinBalance: acc.coinBalance,
        lifetimeEarnedCoins: acc.lifetimeEarnedCoins,
      };
    });
  }

  /** 事务内原子扣减乐币（供卡牌工坊等模块与自身状态表在同一 PG 事务内强一致提交）。 */
  async spendCoinsTx(
    manager: EntityManager,
    input: InternalSpendInput,
    now = new Date(),
  ): Promise<{ alreadyProcessed: boolean; coinBalance: number }> {
    const weekKey = getShanghaiWeekKey(now);
    const existing = await manager.findOne(EconomyLedgerEntryEntity, {
      where: { idempotencyKey: input.idempotencyKey },
    });
    const accounts = await this.lockAccountsTx(manager, [input.userId], now);
    const acc = accounts.get(input.userId)!;

    if (existing) {
      return { alreadyProcessed: true, coinBalance: acc.coinBalance };
    }
    if (acc.coinBalance < input.amount) {
      throw new BadRequestException(
        `当前可用乐币不足（需要 ${input.amount}，可用 ${acc.coinBalance}）`,
      );
    }

    acc.coinBalance -= input.amount;
    acc.updatedAt = now;
    await manager.save(EconomyAccountEntity, acc);

    const entry = manager.create(EconomyLedgerEntryEntity, {
      entryId: randomUUID(),
      txGroupId: randomUUID(),
      orderId: null,
      appId: input.appId,
      userId: input.userId,
      counterpartyUserId: null,
      asset: 'coin',
      delta: -input.amount,
      countsTowardLifetime: false,
      weekKey,
      reason: input.reason,
      title: input.title,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    });
    await manager.save(EconomyLedgerEntryEntity, entry);

    return { alreadyProcessed: false, coinBalance: acc.coinBalance };
  }

  /** 仅限内部服务总线（卡牌抽卡 / 兑换站）使用的乐币消费销毁接口（按 idempotencyKey 强幂等）。 */
  async spendCoins(input: InternalSpendInput): Promise<{
    alreadyProcessed: boolean;
    coinBalance: number;
  }> {
    const now = new Date();
    return this.dataSource.transaction((manager) => this.spendCoinsTx(manager, input, now));
  }

  /** 管理员删除考勤记录时，按原铸币记录幂等冲正对应乐币（余额下限钳零）。 */
  async reverseAttendanceCoins(input: {
    userId: string;
    attendanceSessionId: string;
    weekKey: string;
    fallbackCoins?: number;
  }): Promise<{ reversedCoins: number; coinBalance: number }> {
    const now = new Date();
    const origKey = `punch:attendance:${input.attendanceSessionId}`;
    const revKey = `punch:attendance-delete:${input.attendanceSessionId}`;

    return this.dataSource.transaction(async (manager) => {
      const existingRev = await manager.findOne(EconomyLedgerEntryEntity, {
        where: { idempotencyKey: revKey },
      });
      const accounts = await this.lockAccountsTx(manager, [input.userId], now);
      const acc = accounts.get(input.userId)!;
      if (existingRev) {
        return { reversedCoins: Math.abs(existingRev.delta), coinBalance: acc.coinBalance };
      }

      const origEntry = await manager.findOne(EconomyLedgerEntryEntity, {
        where: { idempotencyKey: origKey },
      });
      const targetAmount = Math.max(
        0,
        Math.round(origEntry ? Math.abs(origEntry.delta) : (input.fallbackCoins ?? 0)),
      );
      if (targetAmount <= 0) {
        return { reversedCoins: 0, coinBalance: acc.coinBalance };
      }

      const actualDebit = Math.min(acc.coinBalance, targetAmount);
      acc.coinBalance -= actualDebit;
      acc.lifetimeEarnedCoins = Math.max(0, acc.lifetimeEarnedCoins - targetAmount);
      acc.updatedAt = now;
      await manager.save(EconomyAccountEntity, acc);

      const entry = manager.create(EconomyLedgerEntryEntity, {
        entryId: randomUUID(),
        txGroupId: randomUUID(),
        orderId: null,
        appId: 'lec-punch',
        userId: input.userId,
        counterpartyUserId: null,
        asset: 'coin',
        delta: -actualDebit,
        countsTowardLifetime: false,
        weekKey: input.weekKey || getShanghaiWeekKey(now),
        reason: 'admin_adjust',
        title: `管理员删除考勤记录冲正（原铸币 ${targetAmount} 乐币）`,
        idempotencyKey: revKey,
        createdAt: now,
      });
      await manager.save(EconomyLedgerEntryEntity, entry);

      return { reversedCoins: actualDebit, coinBalance: acc.coinBalance };
    });
  }

  /** 查询成员指定周的乐币入账总额与消费总额（供卡牌工坊与积分摘要展示）。 */
  async getWeeklyCoinFlow(
    userId: string,
    weekKey: string,
  ): Promise<{ earnedCoins: number; spentCoins: number }> {
    const [row] = (await this.dataSource.query(
      `SELECT
         COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0)::int AS "earnedCoins",
         COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0)::int AS "spentCoins"
       FROM economy_ledger_entries
       WHERE user_id = $1 AND asset = 'coin' AND week_key = $2`,
      [userId, weekKey],
    )) as [{ earnedCoins: number; spentCoins: number }];

    return {
      earnedCoins: Number(row?.earnedCoins ?? 0),
      spentCoins: Number(row?.spentCoins ?? 0),
    };
  }

  /** 读取成员当日/当周风控统计快照。 */
  async getUserRiskMetrics(
    manager: EntityManager,
    userId: string,
    weekKey: string,
    now: Date,
  ): Promise<{
    account: EconomyAccountEntity;
    weeklyRecordedMinutes: number;
    dailyCoinAbsVolume: number;
    weeklyCoinGain: number;
    weeklyPunchNetMinutes: number;
    activeOrdersCount: number;
  }> {
    const accounts = await this.lockAccountsTx(manager, [userId], now);
    const account = accounts.get(userId)!;
    const weeklyRecordedMinutes =
      account.weeklyRecordedWeekKey === weekKey ? account.weeklyRecordedMinutes : 0;

    const { startUtc, endUtc } = getShanghaiDayBounds(now);

    const [dailyCoinRow] = (await manager.query(
      `SELECT COALESCE(SUM(ABS(delta)), 0)::int AS total
       FROM economy_ledger_entries
       WHERE user_id = $1 AND asset = 'coin'
         AND reason IN ('wager_win', 'wager_loss', 'tip_in', 'tip_out')
         AND created_at >= $2 AND created_at < $3`,
      [userId, startUtc, endUtc],
    )) as [{ total: number }];

    const [weeklyCoinGainRow] = (await manager.query(
      `SELECT COALESCE(SUM(delta), 0)::int AS total
       FROM economy_ledger_entries
       WHERE user_id = $1 AND asset = 'coin' AND week_key = $2
         AND reason IN ('wager_win', 'wager_loss')`,
      [userId, weekKey],
    )) as [{ total: number }];

    const [weeklyPunchNetRow] = (await manager.query(
      `SELECT COALESCE(SUM(delta), 0)::int AS total
       FROM economy_ledger_entries
       WHERE user_id = $1 AND asset = 'punch_minutes' AND week_key = $2`,
      [userId, weekKey],
    )) as [{ total: number }];

    const [activeOrdersRow] = (await manager.query(
      `SELECT COUNT(DISTINCT o.id)::int AS cnt
       FROM economy_orders o
       JOIN economy_order_participants p ON p.order_id = o.id
       WHERE p.user_id = $1 AND o.status IN ('pending_accept', 'locked')`,
      [userId],
    )) as [{ cnt: number }];

    return {
      account,
      weeklyRecordedMinutes,
      dailyCoinAbsVolume: Number(dailyCoinRow?.total ?? 0),
      weeklyCoinGain: Math.max(0, Number(weeklyCoinGainRow?.total ?? 0)),
      weeklyPunchNetMinutes: Number(weeklyPunchNetRow?.total ?? 0),
      activeOrdersCount: Number(activeOrdersRow?.cnt ?? 0),
    };
  }

  /** 读取成员钱包与剩余风控额度摘要。 */
  async getWalletSummary(userId: string): Promise<WalletSummaryDTO> {
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);

    const metrics = await this.dataSource.transaction((manager) =>
      this.getUserRiskMetrics(manager, userId, weekKey, now),
    );
    const ec = this.cfg.economy;

    return {
      coinBalance: metrics.account.coinBalance,
      frozenCoins: metrics.account.frozenCoins,
      lifetimeEarnedCoins: metrics.account.lifetimeEarnedCoins,
      weeklyRecordedMinutes: metrics.weeklyRecordedMinutes,
      weeklyTradeMinutes: metrics.weeklyPunchNetMinutes,
      punchAffectsAssessment: ec.punchAffectsAssessment,
      quotas: {
        maxCoinPerOrder: ec.maxCoinPerOrder,
        maxPunchPerOrder: ec.maxPunchPerOrder,
        dailyCoinRemaining: Math.max(0, ec.dailyCoinNetLimit - metrics.dailyCoinAbsVolume),
        weeklyCoinGainRemaining: Math.max(0, ec.weeklyCoinGainLimit - metrics.weeklyCoinGain),
        weeklyPunchGainRemaining: Math.max(
          0,
          ec.weeklyPunchGainLimit - Math.max(0, metrics.weeklyPunchNetMinutes),
        ),
        weeklyPunchLossRemaining: Math.max(
          0,
          ec.weeklyPunchLossLimit - Math.max(0, -metrics.weeklyPunchNetMinutes),
        ),
        activeOrdersCount: metrics.activeOrdersCount,
        maxActiveOrders: ec.maxActiveOrdersPerUser,
      },
    };
  }

  /** 分页查询成员交易流水账单（全链路公开透明审计）。 */
  async listLedger(
    userId: string,
    opts?: { asset?: EconomyAsset; limit?: number },
  ): Promise<EconomyLedgerEntryEntity[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const qb = this.dataSource
      .getRepository(EconomyLedgerEntryEntity)
      .createQueryBuilder('e')
      .where('e.user_id = :userId', { userId })
      .orderBy('e.created_at', 'DESC')
      .take(limit);

    if (opts?.asset) {
      qb.andWhere('e.asset = :asset', { asset: opts.asset });
    }
    return qb.getMany();
  }

  /** 供 LecPunch 统计/周考核读取指定周所有成员的工坊交易增减分钟数。 */
  async getWeeklyTradeMinutesSummary(weekKey: string): Promise<{
    weekKey: string;
    affectsAssessment: boolean;
    items: Array<{ userId: string; tradeMinutes: number }>;
  }> {
    const rows = (await this.dataSource.query(
      `SELECT user_id AS "userId", COALESCE(SUM(delta), 0)::int AS "tradeMinutes"
       FROM economy_ledger_entries
       WHERE asset = 'punch_minutes' AND week_key = $1
       GROUP BY user_id`,
      [weekKey],
    )) as Array<{ userId: string; tradeMinutes: number }>;

    return {
      weekKey,
      affectsAssessment: this.cfg.economy.punchAffectsAssessment,
      items: rows.map((r) => ({ userId: r.userId, tradeMinutes: Number(r.tradeMinutes) })),
    };
  }
}
