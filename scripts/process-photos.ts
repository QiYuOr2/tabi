/**
 * 把原图收成 blog-image 仓库用的实拍图和缩略图：先读 EXIF，再按方向转正、缩小、去掉全部元数据。
 *
 * 用法：
 *   node scripts/process-photos.ts [目录] [原文件名=输出名 ...]
 *     [--bangumi 100444] [--out dist-photos]
 *     [--spots photos/imported-spots.json] [--map photos/map.json]
 *
 * 目录默认 photos/。输出名按这个顺序决定（后面的覆盖前面的）：
 *   1. --spots 里的 anitabiPointId，没有则用 spot id。文件名取 photo 路径或 file 字段。
 *      未指定 --spots 时，如果 photos/imported-spots.json 存在就用它。
 *   2. --map：{ "bangumiId": 100444, "files": { "DSC001.jpg": "51i51ynk8" } }
 *   3. 命令行「原文件名=输出名」
 *
 * 大图最长边 1280（不放大），JPEG 质量 82；缩略图从大图再缩，最长边 320，质量 78。
 * 都是渐进式、mozjpeg、sRGB，不保留 EXIF/GPS。
 * 输出：<out>/<bangumiId>/<name>.jpg 和 <out>/<bangumiId>/thumb/<name>.jpg
 * 另外写 <out>/capture.json，留下处理前读到的 GPS 和拍摄时间。
 */
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { embeddedMetaKind, readPhotoCapture, type PhotoCapture } from "./lib/exif.ts";

const CDN = "https://cdn.jsdelivr.net/gh/QiYuOr2/blog-image@master/tabi";
const FULL = 1280;
const THUMB = 320;
const EXT = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".tif", ".tiff", ".webp", ".avif"]);

const USAGE = `用法: node scripts/process-photos.ts [目录] [原文件名=输出名 ...]
            [--bangumi 100444] [--out dist-photos]
            [--spots photos/imported-spots.json] [--map photos/map.json]`;

interface Assignment {
  name: string;
  bangumiId: number | null;
}

interface Done {
  file: string;
  name: string;
  bangumiId: number;
  capture: PhotoCapture;
  full: { width: number; height: number; bytes: number; path: string };
  thumb: { width: number; height: number; bytes: number; path: string };
  photo: string;
  photoThumb: string;
}

const args = process.argv.slice(2);
const OPTS = new Set(["--bangumi", "--out", "--spots", "--map"]);

function opt(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : null;
}

function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (OPTS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function photoBasename(photo: string): string | null {
  const last = (photo.split("?")[0] ?? photo).split("/").pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function safeName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return null;
  if (name.includes("..")) return null;
  return name;
}

function put(map: Map<string, Assignment>, file: string, assignment: Assignment) {
  const name = safeName(assignment.name);
  if (!name) throw new Error(`输出名不合法：${assignment.name}（${file}）`);
  map.set(basename(file), { name, bangumiId: assignment.bangumiId });
}

function fromRecords(data: unknown[]): { map: Map<string, Assignment>; skipped: number } {
  const map = new Map<string, Assignment>();
  let skipped = 0;
  for (const item of data) {
    if (!isRecord(item)) continue;
    const file =
      typeof item.file === "string"
        ? basename(item.file)
        : typeof item.photo === "string"
          ? photoBasename(item.photo)
          : null;
    const rawName =
      (typeof item.anitabiPointId === "string" && item.anitabiPointId) ||
      (typeof item.id === "string" && item.id) ||
      (typeof item.name === "string" && item.name) ||
      "";
    if (!file || !rawName) {
      skipped++;
      continue;
    }
    put(map, file, {
      name: rawName,
      bangumiId: typeof item.bangumiId === "number" ? item.bangumiId : null,
    });
  }
  return { map, skipped };
}

function fromMapFile(data: Record<string, unknown>): Map<string, Assignment> {
  const files = data.files;
  if (!isRecord(files)) {
    throw new Error('--map 需要 { "bangumiId": 100444, "files": { "原文件名": "输出名" } }');
  }
  const bangumiId = typeof data.bangumiId === "number" ? data.bangumiId : null;
  const map = new Map<string, Assignment>();
  for (const [file, name] of Object.entries(files)) {
    if (typeof name !== "string") throw new Error(`--map 里 ${file} 的输出名不是字符串`);
    put(map, file, { name, bangumiId });
  }
  return map;
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`读不到 ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON：${(e as Error).message}`);
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function jpeg(quality: number) {
  return { quality, progressive: true as const, mozjpeg: true, optimizeCoding: true };
}

async function renderFull(input: string) {
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: FULL, height: FULL, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .jpeg(jpeg(82))
    .toBuffer();
}

async function renderThumb(full: Buffer) {
  return sharp(full)
    .resize({ width: THUMB, height: THUMB, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .jpeg(jpeg(78))
    .toBuffer();
}

async function leftover(path: string): Promise<string | null> {
  const kind = await embeddedMetaKind(path);
  if (kind) return kind;
  const meta = await sharp(path).metadata();
  if (meta.exif?.length) return "EXIF";
  if (meta.icc?.length || meta.hasProfile) return "ICC";
  if (meta.iptc?.length) return "IPTC";
  if (meta.xmp?.length) return "XMP";
  if (meta.orientation && meta.orientation !== 1) return "Orientation";
  if (meta.space !== "srgb") return `色彩空间 ${meta.space}`;
  return null;
}

function kb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function urls(bangumiId: number, name: string) {
  return {
    photo: `${CDN}/${bangumiId}/${name}.jpg`,
    photoThumb: `${CDN}/${bangumiId}/thumb/${name}.jpg`,
  };
}

const positional = positionals();
const pairs = positional.filter((a) => a.includes("="));
const dirs = positional.filter((a) => !a.includes("="));
if (dirs.length > 1 || args.includes("-h") || args.includes("--help")) {
  console.error(USAGE);
  process.exit(dirs.length > 1 ? 1 : 0);
}

const dir = resolve(dirs[0] ?? "photos");
const outDir = resolve(opt("--out") ?? "dist-photos");
const bangumiFlag = opt("--bangumi");
const bangumiOverride = bangumiFlag ? Number(bangumiFlag) : null;
if (bangumiFlag && !Number.isInteger(bangumiOverride)) {
  console.error(`--bangumi 不是整数：${bangumiFlag}`);
  process.exit(1);
}

const spotsArg = opt("--spots");
const mapArg = opt("--map");

let failed = false;
const byFile = new Map<string, Assignment>();

try {
  const spotsPath = spotsArg ?? "photos/imported-spots.json";
  if (spotsArg || (await exists(spotsPath))) {
    const data = await readJson(resolve(spotsPath));
    if (!Array.isArray(data)) throw new Error(`${spotsPath} 应该是 import-photos 写出的数组`);
    const loaded = fromRecords(data);
    for (const [file, assignment] of loaded.map) byFile.set(file, assignment);
    if (loaded.skipped) {
      console.warn(`${spotsPath} 有 ${loaded.skipped} 条没有文件名或输出名，已跳过`);
    }
  }
  if (mapArg) {
    const data = await readJson(resolve(mapArg));
    if (!isRecord(data)) throw new Error(`${mapArg} 应该是对象`);
    for (const [file, assignment] of fromMapFile(data)) byFile.set(file, assignment);
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const file = pair.slice(0, eq);
    const name = pair.slice(eq + 1);
    if (!file || !name) throw new Error(`无法解析 ${pair}，需要 原文件名=输出名`);
    put(byFile, file, { name, bangumiId: null });
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

let files: string[];
try {
  files = (await readdir(dir)).filter((f) => EXT.has(extname(f).toLowerCase())).sort();
} catch {
  console.error(`读不到目录 ${dir}\n${USAGE}`);
  process.exit(1);
}
if (!files.length) {
  console.error(`${dir} 里没有照片\n${USAGE}`);
  process.exit(1);
}

const unmapped = files.filter((f) => !byFile.has(f));
for (const file of unmapped) console.warn(`没有输出名，跳过 ${file}`);
if (unmapped.length) failed = true;

const chosen = files.filter((f) => byFile.has(f));
const jobs: { file: string; name: string; bangumiId: number }[] = [];
const used = new Map<string, string>();
for (const file of chosen) {
  const assignment = byFile.get(file)!;
  const bangumiId =
    bangumiOverride && Number.isInteger(bangumiOverride) ? bangumiOverride : assignment.bangumiId;
  if (!bangumiId || !Number.isInteger(bangumiId) || bangumiId <= 0) {
    console.error(`${file} 没有 bangumiId，请加 --bangumi 或写进 --spots / --map`);
    failed = true;
    continue;
  }
  const key = `${bangumiId}/${assignment.name}`;
  const prev = used.get(key);
  if (prev) {
    console.error(`${file} 和 ${prev} 都要写成 ${key}`);
    failed = true;
    const drop = jobs.findIndex((job) => job.file === prev);
    if (drop >= 0) jobs.splice(drop, 1);
    continue;
  }
  used.set(key, file);
  jobs.push({ file, name: assignment.name, bangumiId });
}
if (!jobs.length) process.exit(1);

const done: Done[] = [];
for (const job of jobs) {
  const { file, name, bangumiId } = job;

  const input = join(dir, file);
  let capture: PhotoCapture = { lat: null, lng: null, takenAt: null };
  try {
    capture = await readPhotoCapture(input);
  } catch (e) {
    console.warn(`${file} 的 EXIF 读失败，仍会缩图：${(e as Error).message}`);
  }

  const { photo, photoThumb } = urls(bangumiId, name);
  const fullPath = join(outDir, String(bangumiId), `${name}.jpg`);
  const thumbPath = join(outDir, String(bangumiId), "thumb", `${name}.jpg`);
  try {
    const fullBuf = await renderFull(input);
    const thumbBuf = await renderThumb(fullBuf);
    await mkdir(dirname(fullPath), { recursive: true });
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(fullPath, fullBuf);
    await writeFile(thumbPath, thumbBuf);
    let dirty: string | null = null;
    for (const written of [fullPath, thumbPath]) {
      const why = await leftover(written);
      if (why) dirty = `${written} 仍带有${why}`;
    }
    if (dirty) {
      await unlink(fullPath).catch(() => {});
      await unlink(thumbPath).catch(() => {});
      throw new Error(dirty);
    }
    const fullMeta = await sharp(fullPath).metadata();
    const thumbMeta = await sharp(thumbPath).metadata();
    done.push({
      file,
      name,
      bangumiId,
      capture,
      full: {
        width: fullMeta.width ?? 0,
        height: fullMeta.height ?? 0,
        bytes: fullBuf.length,
        path: fullPath,
      },
      thumb: {
        width: thumbMeta.width ?? 0,
        height: thumbMeta.height ?? 0,
        bytes: thumbBuf.length,
        path: thumbPath,
      },
      photo,
      photoThumb,
    });
  } catch (e) {
    console.error(`${file} 处理失败：${(e as Error).message}`);
    failed = true;
  }
}

if (done.length) {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "capture.json"),
    JSON.stringify(
      done.map((item) => ({
        file: item.file,
        name: item.name,
        bangumiId: item.bangumiId,
        lat: item.capture.lat,
        lng: item.capture.lng,
        takenAt: item.capture.takenAt,
        photo: item.photo,
        photoThumb: item.photoThumb,
      })),
      null,
      2,
    ) + "\n",
  );
}

console.log(
  `\n处理 ${done.length} 张，跳过 ${unmapped.length} 张。输出目录 ${outDir}` +
    (done.length ? `，拍摄信息在 ${join(outDir, "capture.json")}` : ""),
);
for (const item of done) {
  const gps =
    item.capture.lat != null && item.capture.lng != null
      ? `${item.capture.lat.toFixed(6)}, ${item.capture.lng.toFixed(6)}`
      : "无 GPS";
  console.log(`\n${item.file} → ${item.name}`);
  console.log(`  EXIF  ${gps}  ${item.capture.takenAt ?? "无拍摄时间"}`);
  console.log(
    `  大图  ${item.full.width}×${item.full.height}  ${kb(item.full.bytes)}  ${item.full.path}`,
  );
  console.log(
    `  缩略图  ${item.thumb.width}×${item.thumb.height}  ${kb(item.thumb.bytes)}  ${item.thumb.path}`,
  );
  console.log(`  photo       ${item.photo}`);
  console.log(`  photoThumb  ${item.photoThumb}`);
}
if (done.length) {
  console.log("\n可写入 spots.json 的字段：");
  console.log(
    JSON.stringify(
      done.map((item) => ({ name: item.name, photo: item.photo, photoThumb: item.photoThumb })),
      null,
      2,
    ),
  );
}

if (!done.length) process.exit(1);
process.exit(failed ? 1 : 0);
