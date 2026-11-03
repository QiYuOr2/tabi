# 巡礼照片入库脚本（技术方案）

> 状态：待办（方案），日期 2026-11-03。
> 目标：把现在由 AI agent 临场完成的「巡礼照片入库」，改成 tabi 仓库里一条固定的 Node/TypeScript 脚本 `pnpm intake`。流程固定为 11 步，只有两步调用视觉模型，两步由人在本地网页上确认。
> 现行规则见 [skills/pilgrimage-photo-intake/SKILL.md](skills/pilgrimage-photo-intake/SKILL.md)，数据字段以 `src/types/spot.ts` 为准。本文只做设计，不改现有流程。

## 1. 为什么要改

- 现在每批照片都由 agent 从头规划、试错，耗时长，结果不稳定。
- 真正需要判断的只有两处：认出是哪部作品，以及匹配到哪个 anitabi 地点。其余都是固定规则，写成脚本后更快，每次结果一致，出错也能定位到具体步骤。

## 2. 技术栈

| 环节 | 选型 | 理由 |
| --- | --- | --- |
| 运行方式 | `scripts/intake.ts`，逻辑放在 `scripts/intake/`，`package.json` 加 `"intake": "node scripts/intake.ts"` | 和现有 `photos:process`、`match` 脚本一样，用 Node 直接运行 TS，不加构建步骤和新依赖管理 |
| 图像处理（切图、转正、旋转、裁剪、缩放、WebP） | sharp（仓库已有） | 现有 `scripts/process-photos.ts` 已经用它出图；`.rotate()` 按 EXIF 转正，输出时默认去掉全部元数据 |
| EXIF 读取（拍摄时间、方向） | exifr（仓库已有），复用 `scripts/lib/exif.ts` | 现成的时区换算逻辑可以直接用 |
| anitabi / Bangumi | 复用 `scripts/lib/anitabi.ts`（`getPointsDetail`、`searchBangumi`、`screenshotUrl`） | 接口和坐标规则已经验证过 |
| 识别作品 | trace.moe HTTP API（Node 自带 `fetch`） | 免费，按截图直接给出作品和集数 |
| 视觉模型 | `@google/genai` 调 Gemini 3.1 Flash-Lite，用 `responseMimeType: "application/json"` 加 `responseJsonSchema` 约束输出 | 免费层就够这个用量；输出结构固定，脚本可以直接解析 |
| 预筛 | sharp 算感知哈希（dHash） | anitabi 截图和对比图的动画半张通常是同一帧，哈希距离就能排出前 10，不需要 OpenCV |
| 人工确认和裁剪 | `node:http` 起一个本地页面（默认 `127.0.0.1`），页面是一个静态 HTML 加原生 JS | 在一个页面里完成选地点和框选裁剪，不引入前端框架，也不暴露到外网 |
| 发布 | `child_process` 调本地 git（`tabi`、`blog-image` 两个工作副本） | 沿用本机已有的 git 登录，不需要额外的 GitHub token；用默认提交身份 |
| CDN 检查 | `fetch` 请求 jsDelivr，必要时调 purge 接口 | 现在的手工步骤原样自动化 |

自动对齐（opencv.js）放到后续阶段，默认由人在确认页上框选裁剪。

## 3. 流程总览

```
[1 输入] → [2 切图] → [3 识别作品] → [4 拉候选地点] → [5 匹配地点] → [6 人工确认]
                                                                          ↓
[11 汇报] ← [10 发布] ← [9 出图] ← [8 裁剪] ← [7 原图] ←───────────────────┘
```

- **子命令**：`pnpm intake <目录>` 按顺序跑完全部步骤；`pnpm intake <目录> --from <步骤>` 从断点继续。
- **执行单位**：第 2 到第 9 步对每张图各跑一次，第 10、11 步整批只跑一次。
- **中间结果**：都写进 `.intake/<batchId>/`（加入 `.gitignore`）。

## 4. 各步骤

### 1 输入
- **来源**：`photos/<作品>/` 收件目录，里面放对比图；原图可选，按文件名和对比图对应；作品名或 Bangumi ID 用参数传，也可选。
- **格式**：HEIC 原图用 sharp 能读就直接读，读不了就提示先导出成 JPEG。不支持的文件列出来后跳过。

### 2 切图（sharp）
- **做法**：取灰度像素，按列算梯度，找中间的分隔线；找不到就按中线切，切成 `animeHalf` 和 `realHalf`。
- **异常**：两半的宽高比相差太大时标记 `needs_review`，在第 6 步确认切分位置。

### 3 识别作品（trace.moe + Gemini 兜底）
- **跳过**：传了作品名或 ID 就跳过这一步；作品名用 `searchBangumi` 换成 ID。
- **trace.moe**：`POST https://api.trace.moe/search?cutBorders&anilistInfo` 上传 `animeHalf`。匿名额度每月 100 次、并发 1，脚本里串行调用。
- **Gemini 兜底**：similarity < 0.9 时让 Gemini 给出候选作品名，再用 Bangumi 搜索确认。
- **换算**：trace.moe 返回的是 AniList 条目，集数跨季连续编号，要换回 Bangumi 对应条目的季和集。

### 4 拉候选地点
- **接口**：`getPointsDetail(id, true)`，同一作品在一个批次里只拉一次，失败重试 3 次。
- **没有地点时**：在第 6 步选择「trace.moe 截图 + 手动指定地点」或者跳过。

### 5 匹配地点（dHash 预筛 + Gemini 精排）
- **预筛**：动画半张和所有候选截图都缩成 9×8 灰度图算 dHash，取汉明距离最小的前 10 张。
- **精排**：把 `animeHalf`、`realHalf` 和前 10 张候选都缩到 384px 以内，一次发给 Gemini。
- **提示词**：

```
你会看到一张动画截图 A、一张实拍 R，以及若干编号的候选截图 C1..Cn（同一作品在 anitabi 上的地点截图）。
找出与 A 拍的是同一地点、同一角度的候选。看建筑轮廓、招牌、地面纹理、远景，不看人物和光线。
R 是实拍，可用来辅助判断。只输出 JSON。
```

- **输出 schema**（作为 `responseJsonSchema` 传入）：

```json
{
  "type": "object",
  "properties": {
    "top": {
      "type": "array", "maxItems": 3,
      "items": {
        "type": "object",
        "properties": {
          "pointId": { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "reason": { "type": "string" }
        },
        "required": ["pointId", "confidence"]
      }
    },
    "noMatch": { "type": "boolean" }
  },
  "required": ["top", "noMatch"]
}
```

- **失败处理**：解析失败重试 1 次，还是失败就只用预筛结果。`noMatch` 为真时走 trace.moe 搜帧分支，截图存到图床 `anime/`，`origin` 填 `"trace.moe"`。

### 6 人工确认（本地页面）
- **页面内容**：每张图一张卡片，并排显示对比图和前 3 张候选截图，点选一张，或者选「都不是」「跳过」。
- **自动预选**：Gemini 第一名置信度 ≥ 0.85，并且和预筛第一名一致时自动预选（阈值待回测），但仍然要整批点一次「确认」才往下走。

### 7 原图
- **有原图**：sharp `.rotate()` 转正。exifr 读 `DateTimeOriginal` 和时区偏移，时区设成 UTC+8 的照片换算成拍摄地时间（+09:00）。
- **没有原图**：用 `realHalf` 替补，`takenAt` 记为 `null`，汇报时标明「替补图」。
- **隐私**：原图只在本地读取，不复制到任何会提交的位置。

### 8 裁剪（本地页面）
- **操作**：在同一个页面上，左边是对比图的实拍半张作参考，右边是原图。拖动裁剪框，用滑块调旋转角，得到 `{ angle, crop: [x, y, w, h] }`。
- **默认值**：裁剪框默认按 `realHalf` 的宽高比居中放置；选「不裁剪」就直接用整张原图。
- **以后**：用 opencv.js 做特征匹配，自动给出初始裁剪框（见 TODO 阶段 4）。

### 9 出图（sharp）
- **规格**：转 sRGB，按 `angle`、`crop` 旋转裁剪，然后输出三档，原图比目标尺寸小时不放大：
  - `tabi/<bangumiId>/<pointId>.webp`：长边 1280，q80
  - `mid/`：长边 640，q80
  - `thumb/`：长边 320，q75
- **文件名**：同一个 pointId 的第二张起加 `-2`。
- **自检**：sharp 输出默认不带元数据，出图后再用 `sharp().metadata()` 确认没有 EXIF、XMP，有就让本条失败（沿用 `process-photos.ts` 的检查）。
- **总览图**：同时生成一张并排总览图，左边 anitabi 截图，右边实拍，供第 11 步使用。

### 10 发布（git + fetch）
1. **推图床**：在本地 `blog-image` 工作副本里 `git pull --rebase`，复制图片（已存在的路径跳过），然后提交并推送到 `master`。
2. **jsDelivr 检查**：逐个请求 `https://cdn.jsdelivr.net/gh/QiYuOr2/blog-image@master/<path>`。返回 403 或 404 时请求 `https://purge.jsdelivr.net/gh/QiYuOr2/blog-image@master/<path>`，等待后重试，最多 5 轮。仍有地址失败就中止，不写地图数据。
3. **写数据**：在 tabi 工作副本里 `git pull --rebase`，往 `src/data/spots.json` 只追加 id 不存在的地点；`source: "anitabi"`，坐标取 anitabi 的。同一系列的新作品，把 ID 加进 `src/data/works.json` 对应条目。
4. **推地图**：提交并推送到 `main`。推送被拒就重新拉取、重新追加、再推，不 force push。commit 说明不写坐标。

### 11 汇报
- **终端输出**：线上链接 `https://tabi.qiyuor2.me`、新增地点数、替补图和跳过的条目。
- **本地页面**：显示并排总览图。

## 5. 密钥

- **Gemini**：`GEMINI_API_KEY` 只放在本地环境变量或 `.env.local`（已被 `.gitignore` 忽略），不写进仓库和日志。
- **GitHub**：不需要单独的 token，git 用本机已有的登录推送。
- **trace.moe**：匿名额度够用，不需要 key。

## 6. 幂等与重跑

- **幂等键**：`<bangumiId>-<pointId>`。`spots.json` 里已有的 id 跳过，图床已有的路径不覆盖。
- **断点重跑**：每一步的结果按 `batchId` 缓存在 `.intake/` 里，`--from` 重跑时不会重复调用 Gemini 和 trace.moe。
- **发布顺序**：严格按「先图床、再验证、后数据」执行，任何一步失败都会让后面的步骤停下。

## 7. 预期费用

每月 $0：本地运行，Gemini 3.1 Flash-Lite 用免费层。免费层每天约 500 次请求，以 AI Studio 显示为准。不用免费层时，付费单价是输入 $0.25、输出 $1.50 每百万 token，按每张约 3,600 token 输入估算，100 张约 $0.15。trace.moe 匿名每月 100 次。价格 as of 2026-11。

- **免费层的数据使用**：请求会被用于改进 Google 的产品。发送的只有动画截图和要公开的实拍缩小图，没有元数据和 GPS。介意的话就开通付费，并设 $1/月上限。

来源：[Gemini API 定价](https://ai.google.dev/gemini-api/docs/pricing)、[Gemini 图片 token 计算](https://ai.google.dev/gemini-api/docs/image-understanding)、[Gemini 免费层限额（第三方实测）](https://aiplug.work/en/blog/gemini-free-tier-limits)、[trace.moe API](https://soruly.github.io/trace.moe-api/)。

## 8. 待定问题

- 第 6 步自动预选的阈值，要先拿已入库的约 190 个地点回测。
- dHash 预筛对裁边、加字幕的截图是否够用；不够就把候选数从 10 放宽到 20。
- 旧作品的 JPEG 图片要不要统一成 WebP？在作者决定之前不动。

## 9. TODO

**阶段 0：准备**
- [ ] 用已入库的数据做回测集（对比图、正确的 pointId）
- [ ] 申请 Gemini API key（先用免费层），在 AI Studio 确认实际额度
- [ ] 加 `pnpm intake` 入口、`.intake/` 缓存目录和 `--from` 断点

**阶段 1：图像**
- [ ] 切图（第 2 步）、原图转正和拍摄时间（第 7 步），复用 `scripts/lib/exif.ts`
- [ ] 出图和元数据自检（第 9 步），从 `process-photos.ts` 抽成公用函数

**阶段 2：匹配**
- [ ] trace.moe 识别和 Gemini 兜底（第 3 步）
- [ ] 候选拉取（第 4 步）、dHash 预筛和 Gemini 精排（第 5 步），在回测集上统计准确率

**阶段 3：本地页面和发布**
- [ ] 确认页和裁剪页（第 6、8 步）
- [ ] git 推图床、jsDelivr 检查和 purge、追加数据、推 main（第 10 步）、汇报（第 11 步）
- [ ] 用一批真实照片端到端跑通，和 agent 的结果对比

**阶段 4：后续**
- [ ] opencv.js 自动对齐，给出初始裁剪框
- [ ] 更新 `docs/skills/pilgrimage-photo-intake/SKILL.md`，改成「默认走 `pnpm intake`，agent 只处理疑难条目」
