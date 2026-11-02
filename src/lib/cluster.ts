/** 缩略图按钮尺寸。碰撞范围比它略大，避免贴在一起仍分成两枚。 */
export const THUMB_W = 80;
export const THUMB_H = 45;
export const THUMB_GAP = 8;

export interface ScreenPoint<T> {
  item: T;
  x: number;
  y: number;
}

/**
 * 屏幕坐标上互相重叠的点并成一组。
 * 水平距离小于 xGap、垂直距离小于 yGap 即算重叠，并且会传递（A 碰 B、B 碰 C 则三者一组）。
 */
export function clusterByDistance<T>(
  points: ScreenPoint<T>[],
  xGap: number,
  yGap: number,
): ScreenPoint<T>[][] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    const p = parent[i]!;
    if (p === i) return i;
    const root = find(p);
    parent[i] = root;
    return root;
  };
  const unite = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = Math.abs(points[i]!.x - points[j]!.x);
      const dy = Math.abs(points[i]!.y - points[j]!.y);
      if (dx < xGap && dy < yGap) unite(i, j);
    }
  }
  const groups = new Map<number, ScreenPoint<T>[]>();
  for (let i = 0; i < points.length; i++) {
    const id = find(i);
    const list = groups.get(id);
    if (list) list.push(points[i]!);
    else groups.set(id, [points[i]!]);
  }
  return [...groups.values()];
}
