---
name: 巡礼照片入库
description: >-
  当用户上传动画圣地巡礼实拍照片（聊天附件，或放在 tabi 仓库 photos/<作品>/ 收件目录里，可能附带「对比图」，原图可能在用户 Mac
  的照片图库/iCloud）、要把它们定位并加到巡礼地图（tabi 仓库）上时使用：以对比图为准匹配 anitabi 地点（截图对不上时用
  trace.moe）、在用户电脑本地找原图并按对比图旋转裁剪、压缩成 WebP 原图/中图/缩略图，先提交图床、再把地点加到地图仓库。
---

# 巡礼照片入库

把一批巡礼实拍照片变成巡礼地图上的地点。默认项目设置：地图仓库 `QiYuOr2/tabi`（生产分支 `main`），图床仓库 `QiYuOr2/blog-image`（`master` 分支），照片经 jsDelivr 引用。以仓库 README 和 `scripts/` 为准。

## 规则

- **坐标一律以 anitabi 为准**，地图要能跳转 `https://www.anitabi.cn/map?bangumiId=<id>&pid=<pointId>`。trace.moe 只提供动画截图，不提供坐标。
- **匹配以用户的对比图为准**：作品目录下有 `对比图/` 时，先用对比图把每张实拍和动画画面配对，再找 anitabi 地点。
- **取景以对比图里的实拍半张为准**：旋转、裁剪（包括放大裁切、宽幅）都照对比图做。
- **隐私**：公开图片去掉全部 EXIF/GPS；实拍 GPS 只留在工作目录，不写进任何公开文件、PR 或提交说明，用完删掉带 GPS 的原图副本。不写任何领土/政治相关措辞。
- **提交方式**：图床照片直接提交 `master`。地图仓库只改数据（`spots.json`、文档）时直接提交 `main`，不开 PR；涉及代码（图例合并表、脚本、UI）才开 PR，每个新 PR 用一个新的、标题写清任务的云端代理，等用户说合并再合并。不 force push，不设置自定义 git author（不 `git config user.*`、不 `--author`、不 `git am`），用默认身份。
- **两个仓库分开提交**：一个云端代理只能推它启动时的那个仓库，图床和地图仓库各开一个代理。先图床、验证 jsDelivr 200，再推地图数据，否则线上会短暂裂图。
- **用户本地仓库只读**：不改他本地仓库的 git 状态，不改他的照片图库。
- 地图图钉的预览小图用实拍缩略图；动画截图只放浮窗；anitabi 截图直接引用 `image.anitabi.cn`（标来源、可跳转），不搬到图床。
- 浮窗合并：只有同一 anitabi pointId 的照片合并成翻页；不同 pointId 即使同名同地也各自一个图钉。
- 一部作品多季/多条目时，照片按条目分目录存放，但在图例里合并为一个作品（改 `src/lib/spots.ts` 的合并表，属于代码改动）。
- 聊天里给用户看的图要小：总览图压到几百 KB 以内的 WebP/JPEG，不发视频。

## 步骤

1. **收对比图**
   - 收件目录：用户 Windows 上 `<tabi 仓库>/photos/<作品>/对比图/`（已被 .gitignore 忽略）。在用户电脑上用 `Compress-Archive` 打包到临时目录，CopyToBox 这一个 zip，再删掉临时 zip；解压用 `unzip -O cp936`，保住中文文件名。PowerShell 不支持 `&&`。
   - 聊天附件：找带 EXIF 的原始文件。
   - HEIC 等浏览器看不了的格式先转 JPEG/PNG 再看；动态照片丢掉内嵌视频，只留静态图。
2. **找作品和 anitabi 地点**
   - 确定 Bangumi ID，逐张核对属于哪个条目/季（小说等其他条目也查一下）。
   - 坐标：`https://www.anitabi.cn/d/g.json`；地点名、集数、截图：`https://www.anitabi.cn/d/g<组号>.json`。截图地址：路径开头 `/images/` 换成 `https://image.anitabi.cn/`，加 `?plan=h360`（只认 `h160`/`h360`）。`d/*.json` 只在本地脚本用。
3. **匹配动画画面**：用特征匹配（如 SIFT 内点数）把对比图的动画半张和该条目所有 anitabi 截图比，取第一名，记录第二名分数作为置信度依据。
   - 对不上（anitabi 数据更新过）时：用 trace.moe 搜对比图里的动画那一半（`POST https://api.trace.moe/search?cutBorders&anilistInfo`，原始字节上传；匿名每月 100 次、并发 1，省着用）。命中后下载预览帧（链接会过期），存到图床 `tabi/<bangumiId>/anime/`；小体积就保持原格式，只去元数据。`origin` 填 `"trace.moe"`，`originURL` 填 `https://trace.moe/?url=<图床地址>`。trace.moe 的集数跨季连续编号，换算回本季集数。
4. **在用户电脑上找原图**（原图在 Mac 照片图库/iCloud 时）
   - AppleScript：遍历 `date of every media item` 和 `id of every media item` 在本地筛（`whose date` 会报错，`its` 是保留字），按拍摄日缩小范围；用 `export ... to (POSIX file …) with using originals` 导出（会先从 iCloud 下载原件），导出目录放在用户主目录下（CopyToBox 不读 `/tmp`）；不能直接读 `Photos.sqlite`。
   - 先导出/生成小预览在用户电脑上和对比图的实拍半张做特征匹配，连拍相近时选最贴合的一张。
   - 找不到原图时，可以用对比图的实拍半张作替补（画质较差、拍摄时间为 null），列出来让用户决定要不要。
5. **在用户电脑上处理，只传成品**：把大文件从用户电脑传到处理环境的通道可能很慢、有大小和时长限制，所以不要传原图。在用户电脑上用临时 venv（Pillow）或仓库的 `scripts/process-photos.ts`（可把仓库 clone 到用户的 `~/repos/` 下，只读使用）完成：
   - 按 EXIF 方向转正（检查倒置标记），照对比图旋转/裁剪，转 sRGB；
   - 输出 WebP、去掉全部元数据：原图长边 1280px q80 → `<bangumiId>/`；中图长边 640px q80 → `<bangumiId>/mid/`；缩略图长边 320px q75 → `<bangumiId>/thumb/`；文件名用 anitabi pointId（同一 pointId 第二张起加 `-2`）。
   - 同时生成小尺寸对照总览图；打包成品（通常几 MB）后 CopyToBox，并清理用户电脑上的临时文件和 venv。
   - （已上线的旧作品是 JPEG q82 渐进式/缩略图 q78，中图同格式 q80；用户说统一之前不要改。）
6. **拍摄时间**：取 EXIF DateTimeOriginal 和时区偏移；手机时区和拍摄地不一致时（如安卓设为国内时间），换算成当地时间再写。
7. **请用户确认**：发匹配表（对比图、pointId、地点、条目/集数、裁剪/旋转、输出尺寸、置信度）、压缩过的总览图，列出不确定项（自译地名、替补图、弱匹配）。确认后再提交。
8. **提交图床**：把 tar.gz、sha256 列表和说明交给负责 blog-image 的提交者（如云端代理）：解包到 `tabi/<bangumiId>/`（含 `mid/`、`thumb/`、`anime/`），核对 sha256、只新增文件，直接推 `master`；curl 确认原图、中图、缩略图的 jsDelivr 地址都返回 200（偶发 403 单独重试或 purge）。
9. **加地点数据**：基于最新 `main` 生成只改 `src/data/spots.json` 的普通 diff（字段以 `src/types/spot.ts` 为准：`source: "anitabi"`、`anitabiPointId`、照片 jsDelivr 地址、拍摄时间、截图来源），图床验证通过后由负责 tabi 的提交者 `git apply`（必要时 `--3way`）、跑 `vp check` 和 `pnpm build`，直接推 `main`。图例合并等代码改动另开 PR。
10. **收尾**：确认线上页面和图片可访问；删掉处理环境里带 GPS 的原图副本；归档完成的云端代理；向用户汇报提交号/PR 链接。
