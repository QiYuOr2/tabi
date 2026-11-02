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
  bangumiId: number | null;
  color: string;
  spots: Spot[];
}

/** 按作品分组，每个作品一个固定颜色 */
export function groupByAnime(list: Spot[]): AnimeGroup[] {
  const map = new Map<string, AnimeGroup>();
  for (const s of list) {
    const key = s.bangumiId != null ? String(s.bangumiId) : `name:${s.animeName}`;
    let g = map.get(key);
    if (!g) {
      g = { key, animeName: s.animeName, bangumiId: s.bangumiId, color: "", spots: [] };
      map.set(key, g);
    }
    g.spots.push(s);
  }
  const groups = [...map.values()];
  groups.forEach((g, i) => (g.color = PALETTE[i % PALETTE.length]!));
  return groups;
}
