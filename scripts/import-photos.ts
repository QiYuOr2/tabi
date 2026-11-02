/**
 * 读取一个目录里的原图，用 exifr 提取 GPS 和拍摄时间。
 *   - 有 GPS → 生成 source="exif" 的 Spot，写到 --out（默认 photos/imported-spots.json）
 *   - 没 GPS → 写到 --pending（默认 photos/pending.json），之后用 match-anitabi 或手动补坐标
 *
 * 用法：
 *   node scripts/import-photos.ts <目录> [--out photos/imported-spots.json] [--pending photos/pending.json]
 *                                  [--photo-base /photos/] [--anime 作品名] [--bangumi 115908]
 *
 * animeName / pointName 无法从 EXIF 得到：可用 --anime/--bangumi 给整批指定作品，地点名先用文件名占位。
 * 注意：不会改 src/data/spots.json，确认后再手动合并。
 */
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve, dirname } from "node:path";
import { readPhotoCapture } from "./lib/exif.ts";
import type { PendingPhoto, Spot } from "../src/types/spot.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string | null = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const dir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
if (!dir) {
  console.error(
    "用法: node scripts/import-photos.ts <目录> [--out ...] [--pending ...] [--photo-base ...]",
  );
  process.exit(1);
}
const outPath = resolve(opt("--out", "photos/imported-spots.json")!);
const pendingPath = resolve(opt("--pending", "photos/pending.json")!);
const photoBase = opt("--photo-base", "/photos/")!;
const animeName = opt("--anime");
const bangumiRaw = opt("--bangumi");
const bangumiId = bangumiRaw ? Number(bangumiRaw) : null;

const EXT = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".tif", ".tiff", ".webp", ".avif"]);
const files = (await readdir(dir)).filter((f) => EXT.has(extname(f).toLowerCase())).sort();

const spots: Spot[] = [];
const pending: PendingPhoto[] = [];

for (const file of files) {
  const full = join(dir, file);
  let lat: number | null = null;
  let lng: number | null = null;
  let takenAt: string | null = null;
  try {
    const capture = await readPhotoCapture(full);
    lat = capture.lat;
    lng = capture.lng;
    takenAt = capture.takenAt;
  } catch (e) {
    console.warn(`跳过 ${file}：${(e as Error).message}`);
  }
  const photo = `${photoBase}${encodeURIComponent(file)}`;

  if (typeof lat === "number" && typeof lng === "number" && !(lat === 0 && lng === 0)) {
    spots.push({
      id: `photo-${basename(file, extname(file))}`,
      bangumiId,
      animeName: animeName ?? "",
      pointName: basename(file, extname(file)),
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      animeImage: null,
      photo,
      takenAt,
      source: "exif",
      anitabiPointId: null,
    });
  } else {
    pending.push({ file, photo, takenAt, bangumiId, animeName, pointName: null });
  }
}

for (const p of [outPath, pendingPath]) await mkdir(dirname(p), { recursive: true });
await writeFile(outPath, JSON.stringify(spots, null, 2) + "\n");
await writeFile(pendingPath, JSON.stringify(pending, null, 2) + "\n");
console.log(
  `扫描 ${files.length} 张：${spots.length} 张有 GPS → ${outPath}；${pending.length} 张待定位 → ${pendingPath}`,
);
