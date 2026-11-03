/**
 * anitabi 开放 API 的最小封装。
 * 文档：https://github.com/anitabi/anitabi.cn-document/blob/main/api.md
 *
 * 坐标字段：文档写的是 `geo: [lat, lng]`（litePoints 和 points/detail 都有）。
 * 但 2026-11-02 实测这两个接口返回里都没有 `geo` 字段，所以这里按顺序回退：
 *   1. point.geo（文档字段，若以后恢复）
 *   2. 从 originURL 里的 `ll=lat,lng` 解析（Google Maps 来源的地标有）
 *   3. 都没有 → 坐标为 null，需要手动标注
 */

const BASE = "https://api.anitabi.cn";
const UA = "tabi-pilgrimage-map (local script)";

export interface AnitabiPoint {
  id: string;
  name: string;
  cn?: string;
  image?: string;
  ep?: number;
  s?: number;
  geo?: [number, number];
  origin?: string;
  originURL?: string;
}

export interface AnitabiLite {
  id: number;
  cn: string;
  title: string;
  city?: string;
  color?: string;
  geo?: [number, number];
  litePoints: AnitabiPoint[];
  pointsLength: number;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ← ${url}`);
  return (await res.json()) as T;
}

export const getLite = (bangumiId: number) =>
  getJSON<AnitabiLite>(`${BASE}/bangumi/${bangumiId}/lite`);

export const getPointsDetail = (bangumiId: number, haveImage = false) =>
  getJSON<AnitabiPoint[]>(
    `${BASE}/bangumi/${bangumiId}/points/detail${haveImage ? "?haveImage=true" : ""}`,
  );

export type CoordFrom = "geo" | "originURL";

export function pointCoord(p: AnitabiPoint): { lat: number; lng: number; from: CoordFrom } | null {
  if (Array.isArray(p.geo) && p.geo.length === 2)
    return { lat: p.geo[0], lng: p.geo[1], from: "geo" };
  if (p.originURL) {
    try {
      const ll = new URL(p.originURL).searchParams.get("ll");
      const m = ll?.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (m) return { lat: Number(m[1]), lng: Number(m[2]), from: "originURL" };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 截图换成适合展示的 h360 尺寸（文档：替换 plan=h160） */
export const screenshotUrl = (image?: string) => image?.replace("plan=h160", "plan=h360") ?? null;

/** Bangumi 条目搜索（type=2 动画），用于只知道作品名的情况 */
export async function searchBangumi(keyword: string) {
  const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=small`;
  const r = await getJSON<{ list?: { id: number; name: string; name_cn: string }[] }>(url);
  return r.list ?? [];
}
