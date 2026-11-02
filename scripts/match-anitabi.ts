/**
 * 按作品 + 地点名，从 anitabi 拉地标列表做模糊匹配，输出候选和坐标。
 *
 * 用法：
 *   node scripts/match-anitabi.ts <bangumiId|作品名> <地点名> [--top 5] [--json]
 * 例：
 *   node scripts/match-anitabi.ts 115908 宇治橋
 *   node scripts/match-anitabi.ts 上低音号 京都音乐厅
 */
import {
  getLite,
  getPointsDetail,
  pointCoord,
  screenshotUrl,
  searchBangumi,
} from "./lib/anitabi.ts";
import { similarity } from "./lib/fuzzy.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--top"),
);
const [animeArg, pointName] = positional;
if (!animeArg || !pointName) {
  console.error(
    "用法: node scripts/match-anitabi.ts <bangumiId|作品名> <地点名> [--top 5] [--json]",
  );
  process.exit(1);
}
const top = Number(opt("--top", "5"));

let bangumiId = Number(animeArg);
if (!Number.isInteger(bangumiId)) {
  const hits = await searchBangumi(animeArg);
  if (!hits.length) {
    console.error(`Bangumi 上没搜到「${animeArg}」`);
    process.exit(2);
  }
  console.error("Bangumi 搜索结果（取第一个）：");
  for (const h of hits.slice(0, 5)) console.error(`  ${h.id}\t${h.name_cn || h.name}`);
  bangumiId = hits[0]!.id;
}

const [lite, detail] = await Promise.all([getLite(bangumiId), getPointsDetail(bangumiId)]);
// detail 里只有原名 name；lite 的前十个地标还带中文名 cn，合并进来一起匹配
const cnById = new Map(lite.litePoints.map((p) => [p.id, p.cn]));

const candidates = detail
  .map((p) => {
    const cn = p.cn ?? cnById.get(p.id);
    const score = Math.max(similarity(pointName, p.name), cn ? similarity(pointName, cn) : 0);
    const coord = pointCoord(p);
    return {
      score: Number(score.toFixed(3)),
      anitabiPointId: p.id,
      name: p.name,
      cn: cn ?? null,
      lat: coord?.lat ?? null,
      lng: coord?.lng ?? null,
      coordFrom: coord?.from ?? null,
      animeImage: screenshotUrl(p.image),
      ep: p.ep ?? null,
      origin: p.origin ?? null,
      originURL: p.originURL ?? null,
    };
  })
  .filter((c) => c.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, top);

if (flag("--json")) {
  console.log(
    JSON.stringify(
      { bangumiId, animeName: lite.cn || lite.title, query: pointName, candidates },
      null,
      2,
    ),
  );
} else {
  console.log(
    `${lite.cn || lite.title}（bangumiId=${bangumiId}，共 ${detail.length} 个地标）  查询：${pointName}`,
  );
  if (!candidates.length) console.log("  没有候选，考虑 geocode 或手动标注");
  for (const c of candidates) {
    const coord = c.lat != null ? `${c.lat},${c.lng} (${c.coordFrom})` : "无坐标→需手动";
    console.log(
      `  ${c.score.toFixed(2)}  ${c.anitabiPointId}  ${c.name}${c.cn ? ` / ${c.cn}` : ""}  ep${c.ep ?? "?"}  ${coord}`,
    );
  }
}
