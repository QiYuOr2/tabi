import rawSpots from "../data/spots.json";
import type { Spot } from "../types/spot";

export const spots = rawSpots as Spot[];

const PALETTE = [
  "#e8590c",
  "#1c7ed6",
  "#2f9e44",
  "#ae3ec9",
  "#f08c00",
  "#0c8599",
  "#e03131",
  "#5f3dc4",
  "#66a80f",
  "#d6336c",
];

export interface AnimeGroup {
  key: string;
  animeName: string;
  /** 组里第一条地点自己的 bangumiId，不是合并后的唯一条目。 */
  bangumiId: number | null;
  color: string;
  spots: Spot[];
}

/**
 * 多个 bangumi 条目属于同一作品。图例、定位和显隐按 key 合并，显示名用 name。
 * 地点上的 bangumiId 不动，anitabi 链接仍指向各自的条目。
 */
const WORK_BY_BANGUMI: Record<number, { key: string; name: string }> = {
  290: { key: "fate-stay-night", name: "Fate/stay night 系列" },
  935: { key: "fate-stay-night", name: "Fate/stay night 系列" },
  95225: { key: "fate-stay-night", name: "Fate/stay night 系列" },
  109386: { key: "fate-stay-night", name: "Fate/stay night 系列" },
  109375: { key: "fate-stay-night", name: "Fate/stay night 系列" },
  175600: { key: "fate-stay-night", name: "Fate/stay night 系列" },
  474906: { key: "shoushimin", name: "小市民系列" },
  513018: { key: "shoushimin", name: "小市民系列" },
  485: { key: "haruhi", name: "凉宫春日系列" },
  1606: { key: "haruhi", name: "凉宫春日系列" },
  3375: { key: "haruhi", name: "凉宫春日系列" },
  394260: { key: "bokuyaba", name: "我心里危险的东西" },
  441795: { key: "bokuyaba", name: "我心里危险的东西" },
};

function workOf(spot: Spot): { key: string; name: string } {
  const listed = spot.bangumiId != null ? WORK_BY_BANGUMI[spot.bangumiId] : undefined;
  if (listed) return listed;
  return {
    key: spot.bangumiId != null ? String(spot.bangumiId) : `name:${spot.animeName}`,
    name: spot.animeName,
  };
}

/** 浮窗和分组用的作品名。未合并的作品就是地点上的 animeName。 */
export function workName(spot: Spot): string {
  return workOf(spot).name;
}

const BANGUMI_ID = /^[1-9]\d*$/;

/** 这一组对应的 bangumi 条目。合并系列含 WORK_BY_BANGUMI 里的每一季。 */
function bangumiIdsFor(group: AnimeGroup): number[] {
  const ids = new Set<number>();
  for (const spot of group.spots) {
    if (spot.bangumiId != null) ids.add(spot.bangumiId);
  }
  for (const [id, work] of Object.entries(WORK_BY_BANGUMI)) {
    if (work.key === group.key) ids.add(Number(id));
  }
  return [...ids];
}

/** 写进 ?work= 的条目 id。合并系列用最早一季（最小 bangumi id）。 */
export function canonicalWorkId(group: AnimeGroup): string | null {
  const ids = bangumiIdsFor(group);
  if (ids.length === 0) return null;
  return String(Math.min(...ids));
}

/**
 * 用 bangumi 条目 id 找到图例上的那一组。
 * 合并系列的任一季都落到整组。对不上时返回 null。
 */
export function groupByWorkId(list: AnimeGroup[], workId: string): AnimeGroup | null {
  if (!BANGUMI_ID.test(workId)) return null;
  const id = Number(workId);
  const merged = WORK_BY_BANGUMI[id];
  if (merged) return list.find((group) => group.key === merged.key) ?? null;
  return (
    list.find(
      (group) => group.key === workId || group.spots.some((spot) => spot.bangumiId === id),
    ) ?? null
  );
}

/** 按作品分组，每个作品一个固定颜色 */
export function groupByAnime(list: Spot[]): AnimeGroup[] {
  const map = new Map<string, AnimeGroup>();
  for (const s of list) {
    const { key, name } = workOf(s);
    let g = map.get(key);
    if (!g) {
      g = { key, animeName: name, bangumiId: s.bangumiId, color: "", spots: [] };
      map.set(key, g);
    }
    g.spots.push(s);
  }
  const groups = [...map.values()];
  groups.forEach((g, i) => (g.color = PALETTE[i % PALETTE.length]!));
  return groups;
}
