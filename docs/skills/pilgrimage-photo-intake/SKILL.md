---
name: pilgrimage-photo-intake
description: 把动画圣地巡礼实拍照片（可附带对比图）定位到 anitabi 地点、压缩成 WebP 和缩略图、提交图床，并加到巡礼地图的 spots.json。处理新一批巡礼照片时使用。
---

# 巡礼照片入库

把一批巡礼实拍照片变成巡礼地图上的地点。默认项目设置：地图仓库 `QiYuOr2/tabi`（生产分支 `main`），图床仓库 `QiYuOr2/blog-image`（`master` 分支），照片经 jsDelivr 引用。以仓库 README 和 `scripts/` 为准。

## 规则

- **坐标一律以 anitabi 为准**，地图要能跳转 `https://www.anitabi.cn/map?bangumiId=<id>&pid=<pointId>`。trace.moe 只提供动画截图，不提供坐标。
- **匹配以用户的对比图为准**：用户若在作品目录下放了 `对比图/`，先用对比图把每张实拍和动画画面配对，再找 anitabi 地点。
- **隐私**：公开图片去掉全部 EXIF/GPS；实拍 GPS 只留在本机工作目录，不写进任何公开文件、PR 或提交说明。不写任何领土/政治相关措辞。
- **提交方式**：图床照片直接提交到 `master`，不开 PR、不 force push。地图仓库只改数据（`spots.json`）时可直接提交 `main`；涉及代码（图例合并规则、脚本、UI）就开 PR，等用户说合并再合并。
- **用户本地仓库只读**：从用户电脑的收件目录拷照片到自己机器处理，不改他本地仓库的 git 状态。
- 地图图钉的预览小图用实拍；动画截图只放浮窗。
- 浮窗合并：只有同一 anitabi pointId 的照片合并成翻页；不同场景即使很近也各自一个图钉。
- 一部作品多季/多条目时，照片按条目分目录存放，但在图例里合并为一个作品（改 `src/lib/spots.ts` 的合并表，属于代码改动）。
- 聊天里给用户看的图要小：总览图压到几百 KB 以内的 WebP/JPEG，不发视频。

## 步骤

1. **收图**
   - 聊天上传的图片可能被压缩（长边 1024px），以原图为准：从用户的照片图库导出原图（iCloud 上的要先下载原件），HEIC 转 JPEG。
   - 收件目录：`<tabi 仓库>/photos/<作品>/`（已被 .gitignore 忽略），对比图在其下 `对比图/`。拷到自己的工作目录处理。
   - HEIC 等浏览器看不了的格式先转 JPEG/PNG 再看；MVIMG 动态照片丢弃内嵌视频。
2. **读 EXIF**：GPS、拍摄时间（DateTimeOriginal 及时区偏移）、方向。
3. **找作品**：确定 Bangumi ID，逐张核对属于哪个条目/季。
4. **拿 anitabi 地点**
   - 坐标：`https://www.anitabi.cn/d/g.json`（所有地点都带 geo）。
   - 地点名、集数、截图：`https://www.anitabi.cn/d/g<组号>.json`，组号见 g.json。
   - 截图地址：路径开头 `/images/` 换成 `https://image.anitabi.cn/`，加 `?plan=h360`（图钉用 `h160`）。
   - `d/*.json` 是 anitabi 前端内部数据，只在本地脚本用，线上不要直接请求。
5. **匹配**
   - 用 EXIF 坐标或地名圈出约 300–600m 范围，结合对比图里的动画画面逐张比对 anitabi 截图，选定 pointId。
   - anitabi 截图和对比图对不上（anitabi 数据更新过）时：用 trace.moe 搜对比图里的动画那一半（`POST https://api.trace.moe/search?cutBorders&anilistInfo`，原始字节上传；匿名每月 100 次、并发 1，`/me` 查额度，省着用）。命中后下载预览帧（预览链接会过期），存到图床 `tabi/<bangumiId>/anime/`；小体积就保持原 JPEG，只去元数据。该地点 `origin` 填 `"trace.moe"`、`originURL` 填 `https://trace.moe/?url=<图床地址>`，浮窗会显示「截图来源：trace.moe」。注意 trace.moe 的集数跨季连续编号（如第二季第 4 话显示为 16），写进数据和说明时换算回本季集数。
   - 每张标置信度、依据、已验证/推测；拿不准的列出来请用户确认（用户可能直接给 anitabi 链接），不编坐标。
6. **轻微旋转/裁剪**（用户提出或明显需要时）：以对比图的动画构图为参照，扶正小角度倾斜、按需裁到接近动画取景；保持克制，逐张记录角度和裁剪范围给用户确认。
7. **压缩和缩略图**：用 tabi 仓库 `scripts/process-photos.ts`（`pnpm photos:process`，`--format webp`）或 Pillow 同参数：按 EXIF 方向转正，长边 1280px，WebP q80；缩略图长边 320px，q75；去掉所有元数据。文件名用 anitabi pointId（同一 pointId 第二张起加 `-2`）。输出 `<bangumiId>/`、`<bangumiId>/thumb/`，打包并生成 sha256 列表。（已上线的旧作品是 JPEG q82 渐进式/缩略图 q78，用户说统一之前不要改。）
8. **提交图床**：按原字节提交到 `master` 的 `tabi/<bangumiId>/`、`thumb/`、`anime/`，核对 sha256、确认无 EXIF。用 curl 确认 `https://cdn.jsdelivr.net/gh/QiYuOr2/blog-image@master/tabi/<bangumiId>/<name>.webp` 返回 200（偶发 403 单独重试或 purge）。没有 GitHub 凭据时，把 tar.gz 和说明文件交给云端代理去提交；图床和地图仓库各用一个代理（开在哪个仓库上就只能推哪个仓库）。
9. **加地点数据**：在 `src/data/spots.json` 加记录，字段以 `src/types/spot.ts` 为准：`source: "anitabi"`、`anitabiPointId`、`photo`/`photoThumb` 用 jsDelivr 地址、拍摄日期、截图来源。基于最新 `main`，跑 `vp check` 和构建。只改数据就直接提交 `main`；有代码改动就开新 PR（每个新 PR 用一个新的、标题写清任务的云端代理），附预览截图。
10. **汇报**：给用户一张匹配表（照片、地点、集数、置信度、依据、截图来源、旋转裁剪、已验证/推测），附一张压缩过的对比总览图和提交/PR 链接。上线后确认页面和图片可访问。
