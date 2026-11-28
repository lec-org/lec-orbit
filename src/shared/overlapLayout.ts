/**
 * 通用一维区间重叠聚类、贪心分列、空列扩张（colSpan）与高并发阶梯微叠布局算法。
 * 自包含在 Orbit 仓内，不依赖组件库私有内部路径或未发布导出，供课表、多人时间轴与单测统一复用。
 */

export interface OverlapIntervalInput {
  id: string;
  start: number;
  end: number;
}

export interface OverlapIntervalLayout {
  id: string;
  column: number;
  colSpan: number;
  columnCount: number;
  /** 横向起始百分比（0-100）。 */
  leftPercent: number;
  /** 横向渲染宽度百分比（0-100，含高并发下的阶梯微叠增宽）。 */
  widthPercent: number;
  /** 层级顺序，配合阶梯叠放与 hover 提层使用。 */
  zIndex: number;
}

/**
 * 通用一维区间重叠聚类 + 贪心分列 + 空列向右扩张（colSpan）+ 高并发阶梯微叠布局：
 * - 按真实区间 [start, end) 判定重叠，避免紧邻短事件被误判并发；
 * - 2 列及以内严格并排无遮挡；
 * - 右侧相邻列在当前事件区间内无占用时自动向右扩张（colSpan），消除空白洞；
 * - 3 列及以上高并发时，非末列适度向右微叠并按列递增 zIndex，提升窄列标题可读性。
 */
export function layoutOverlappingIntervals(
  items: readonly OverlapIntervalInput[],
  options?: { cascadeThreshold?: number; cascadeExtraRatio?: number },
): Map<string, OverlapIntervalLayout> {
  const result = new Map<string, OverlapIntervalLayout>();
  if (items.length === 0) return result;

  const cascadeThreshold = options?.cascadeThreshold ?? 3;
  const cascadeExtraRatio = options?.cascadeExtraRatio ?? 0.38;

  const sorted = [...items]
    .map((item) => ({
      id: item.id,
      start: item.start,
      end: Math.max(item.start + 1e-6, item.end),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const clusters: Array<typeof sorted> = [];
  let currentCluster: typeof sorted = [];
  let clusterEnd = -Infinity;

  for (const item of sorted) {
    if (currentCluster.length === 0 || item.start < clusterEnd) {
      currentCluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.end);
    } else {
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterEnd = item.end;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  for (const cluster of clusters) {
    const columnItems: Array<Array<(typeof sorted)[number]>> = [];
    const columnEnds: number[] = [];
    const placed: Array<{ item: (typeof sorted)[number]; col: number }> = [];

    for (const item of cluster) {
      let col = columnEnds.findIndex((end) => end <= item.start);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(item.end);
        columnItems.push([item]);
      } else {
        columnEnds[col] = item.end;
        columnItems[col]!.push(item);
      }
      placed.push({ item, col });
    }

    const totalCols = Math.max(1, columnEnds.length);
    const unitWidth = 100 / totalCols;

    for (const { item, col } of placed) {
      let colSpan = 1;
      while (col + colSpan < totalCols) {
        const nextColList = columnItems[col + colSpan]!;
        const hasConflict = nextColList.some(
          (other) => other.start < item.end && item.start < other.end,
        );
        if (hasConflict) break;
        colSpan += 1;
      }

      const leftPercent = col * unitWidth;
      let widthPercent = colSpan * unitWidth;

      const isLastEdge = col + colSpan >= totalCols;
      if (totalCols >= cascadeThreshold && !isLastEdge) {
        const extra = Math.min(unitWidth * cascadeExtraRatio, 100 - leftPercent - widthPercent);
        if (extra > 0) {
          widthPercent += extra;
        }
      }

      result.set(item.id, {
        id: item.id,
        column: col,
        colSpan,
        columnCount: totalCols,
        leftPercent,
        widthPercent,
        zIndex: 2 + col,
      });
    }
  }

  return result;
}

export interface TimedLayoutInput {
  id: string;
  startMinutes: number;
  endMinutes: number;
}

export interface TimedLayoutResult {
  id: string;
  column: number;
  colSpan: number;
  columnCount: number;
  leftPercent: number;
  widthPercent: number;
  zIndex: number;
  topPercent: number;
  heightPercent: number;
}

/** 对同一天内的时段日程做重叠聚类、空列扩张与阶梯避让计算。 */
export function layoutDayTimedEvents(
  items: readonly TimedLayoutInput[],
): Map<string, TimedLayoutResult> {
  const result = new Map<string, TimedLayoutResult>();
  if (items.length === 0) return result;

  const normalized = items.map((item) => {
    const startMinutes = Math.max(0, Math.min(24 * 60 - 5, item.startMinutes));
    const realEnd = Math.max(startMinutes + 5, Math.min(24 * 60, item.endMinutes));
    return {
      id: item.id,
      startMinutes,
      endMinutes: realEnd,
    };
  });

  const horizontal = layoutOverlappingIntervals(
    normalized.map((item) => ({
      id: item.id,
      start: item.startMinutes,
      end: item.endMinutes,
    })),
  );

  for (const item of normalized) {
    const h = horizontal.get(item.id);
    if (!h) continue;
    const minVisibleMinutes = 24;
    const visualDuration = Math.max(minVisibleMinutes, item.endMinutes - item.startMinutes);
    const maxAllowedDuration = Math.max(5, 24 * 60 - item.startMinutes);
    result.set(item.id, {
      id: item.id,
      column: h.column,
      colSpan: h.colSpan,
      columnCount: h.columnCount,
      leftPercent: h.leftPercent,
      widthPercent: h.widthPercent,
      zIndex: h.zIndex,
      topPercent: (item.startMinutes / (24 * 60)) * 100,
      heightPercent: (Math.min(visualDuration, maxAllowedDuration) / (24 * 60)) * 100,
    });
  }

  return result;
}
