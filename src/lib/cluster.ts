/** 实拍缩略图外框。锚点在底边中点，碰撞用画面中心。 */
export const THUMB_W = 72;
export const THUMB_H = 54;
/** 同一坐标散开时，相邻图钉之间留的缝。聚类不另加缝。 */
export const THUMB_GAP = 8;

/** 白底外圈，和角标同一套 2px 描边。 */
const RING = 2;
/** 数量角标相对外框右上角的探出。见 .spot-thumb-count。 */
const BADGE_OUTSET = 7;
const BADGE_H = 18;

export interface ScreenPoint<T> {
  item: T;
  /** 缩略图中心的屏幕坐标，y 向下。 */
  x: number;
  y: number;
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** 相对缩略图中心。含 2px 描边。 */
const CARD: Box = {
  l: -THUMB_W / 2 - RING,
  r: THUMB_W / 2 + RING,
  t: -THUMB_H / 2 - RING,
  b: THUMB_H / 2 + RING,
};

function badgeBox(width: number): Box {
  const right = THUMB_W / 2 + BADGE_OUTSET + RING;
  const top = -THUMB_H / 2 - BADGE_OUTSET - RING;
  return {
    l: right - RING - width - RING,
    r: right,
    t: top,
    b: top + RING + BADGE_H + RING,
  };
}

/** 画面上实际会画出来的块。单张没有角标；reserve 为真时按至少两张留出角标。 */
function previewBoxes(
  count: number,
  badgeWidth: (count: number) => number,
  reserve: boolean,
): Box[] {
  const n = reserve ? Math.max(count, 2) : count;
  if (n <= 1) return [CARD];
  return [CARD, badgeBox(badgeWidth(n))];
}

function hits(
  a: { x: number; y: number },
  b: { x: number; y: number },
  aBoxes: Box[],
  bBoxes: Box[],
) {
  for (const A of aBoxes) {
    for (const B of bBoxes) {
      if (
        a.x + A.l < b.x + B.r &&
        a.x + A.r > b.x + B.l &&
        a.y + A.t < b.y + B.b &&
        a.y + A.b > b.y + B.t
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 两枚已经决定要画出来的预览（中心点）是否叠在一起。角标按实际张数算。 */
export function previewsOverlap(
  a: { x: number; y: number },
  aCount: number,
  b: { x: number; y: number },
  bCount: number,
  badgeWidth: (count: number) => number,
) {
  return hits(
    a,
    b,
    previewBoxes(aCount, badgeWidth, false),
    previewBoxes(bCount, badgeWidth, false),
  );
}

/**
 * 只把会挡住代表图钉的点并进同一组。
 *
 * 点需按代表优先级排好（靠前的先占位）。一个点的预览不和已有代表重叠，就自己成一组。
 * 不再因为「A 碰 B、B 碰 C」把其实分得开的 A 和 C 并成一枚。
 * 角标会随张数变宽，占位时按至少两张来留出右上角。
 * canLead 为 false 的点（屏幕外）不占代表，只并进它真正压住的那一组。
 */
export function clusterByOverlap<T>(
  points: ScreenPoint<T>[],
  badgeWidth: (count: number) => number,
  canLead: (point: ScreenPoint<T>) => boolean = () => true,
): ScreenPoint<T>[][] {
  const groups = new Map<number, number[]>();
  const placed = new Set<number>();

  const hostOf = (index: number, boxes: Box[], reserve: boolean, visibleOnly: boolean) => {
    for (const [leader, members] of groups) {
      if (visibleOnly && !canLead(points[leader]!)) continue;
      const leaderBoxes = previewBoxes(members.length, badgeWidth, reserve);
      if (hits(points[index]!, points[leader]!, boxes, leaderBoxes)) return members;
    }
    return undefined;
  };

  const place = (index: number) => {
    const onCard = hostOf(index, [CARD], false, false);
    if (onCard) {
      onCard.push(index);
      placed.add(index);
      return;
    }
    const onBadge = hostOf(index, previewBoxes(2, badgeWidth, true), true, false);
    if (onBadge) {
      onBadge.push(index);
      placed.add(index);
      return;
    }
    groups.set(index, [index]);
    placed.add(index);
  };

  for (let i = 0; i < points.length; i++) {
    if (canLead(points[i]!)) place(i);
  }
  for (let i = 0; i < points.length; i++) {
    if (!placed.has(i)) place(i);
  }

  // 角标落定之后，卡片已经不压住代表的点，能单独摆开就摆开。
  // 屏幕外的点不再去当新的代表，避免把画面上的图钉吸走。
  for (let pass = 0; pass < points.length; pass++) {
    let changed = false;
    // 这一轮里新拆出来的组留到下一轮，避免边改边遍历。
    const leaders = Array.from(groups.keys());
    for (const leader of leaders) {
      const members = groups.get(leader)!;
      const boxes = previewBoxes(members.length, badgeWidth, false);
      const keep = [leader];
      const eject: number[] = [];
      for (const index of members) {
        if (index === leader) continue;
        if (hits(points[index]!, points[leader]!, [CARD], boxes)) keep.push(index);
        else eject.push(index);
      }
      if (eject.length === 0) continue;
      groups.set(leader, keep);
      for (const index of eject) {
        const visibleOnly = canLead(points[index]!);
        const host = hostOf(index, [CARD], false, visibleOnly);
        if (host) {
          if (host !== keep) {
            host.push(index);
            changed = true;
          } else {
            keep.push(index);
          }
          continue;
        }
        const blocked = hostOf(index, previewBoxes(2, badgeWidth, true), true, visibleOnly);
        if (!blocked) {
          groups.set(index, [index]);
          changed = true;
          continue;
        }
        // 单独摆开会压住别的预览。画面内的点留在原代表下面，画面外的各自收起。
        if (visibleOnly) keep.push(index);
        else {
          groups.set(index, [index]);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return [...groups.values()].map((indexes) => indexes.map((index) => points[index]!));
}
