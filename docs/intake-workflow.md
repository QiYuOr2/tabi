# 巡礼照片入库工作流（技术方案）

> 状态：待办（方案），日期 2026-11-03。
> 目标：把现在由 AI agent 临场完成的「巡礼照片入库」，改成一条固定的 AI 工作流（Dify / n8n 这类：确定性节点 + 少量 LLM/视觉节点 + 人工确认）。
> 现行规则见 [skills/pilgrimage-photo-intake/SKILL.md](skills/pilgrimage-photo-intake/SKILL.md)，数据字段以 `src/types/spot.ts` 为准。本文只做设计，不改现有流程。

## 1. 为什么要改

- 现在每批照片都由 agent 从头规划、试错，耗时长，结果不稳定，偶尔会走偏。
- 整个流程里真正需要「判断」的只有两处：认出是哪部作品，以及匹配到哪个 anitabi 地点。其余步骤都是固定规则。
- 改成工作流以后，只有少数节点调用模型，其余都是代码。好处是更快、更便宜，同样的输入每次得到同样的结果，出错也能定位到具体节点。

## 2. 现行流程（简述）

1. **收图**：对比图左半是动画截图，右半是实拍。
2. **定作品和地点**：先确定 Bangumi ID，再从 anitabi 拉这部作品的全部地点和截图，用特征匹配把对比图的动画半张和截图配对。anitabi 上对不上时，用 trace.moe 按截图搜帧。
3. **找原图**：去照片图库或 iCloud 里找对应的原图。找不到时，用对比图的实拍半张替补。
4. **旋转裁剪**：照对比图实拍半张的取景来，包括放大裁切和宽幅。
5. **出图**：输出 WebP，去掉全部元数据，文件名用 anitabi pointId（同一个 pointId 的第二张起加 `-2`）。
   - 原图：长边 1280，q80
   - `mid/`：长边 640，q80
   - `thumb/`：长边 320，q75
6. **拍摄时间**：从 EXIF 读取。安卓手机的时区设成了 UTC+8，所以在日本拍的照片要换算成当地时间（+09:00）再写入。
7. **人工确认**：看并排总览图，左边是 anitabi 截图，右边是处理后的实拍。
8. **上图床**：推到 `QiYuOr2/blog-image` 的 `master` 分支，放在 `tabi/<bangumiId>/`（含 `mid/`、`thumb/`，trace.moe 帧放 `anime/`）。然后逐个检查 jsDelivr 地址；返回 403 `Package size exceeded` 是 `@master` 缓存过期，purge 一次就好。
9. **写数据**：往 `src/data/spots.json` 追加地点，spot id 为 `<bangumiId>-<pointId>`。同一系列的所有季和剧场版在 `src/data/works.json` 里合并成一个图例作品。改完直接推 tabi `main`，由 Vercel 自动部署。
10. **线上验证**。

另外有两条固定约定：anitabi 截图直接引用 `image.anitabi.cn`（`?plan=h360`），不搬到图床；公开文件里不出现任何 GPS 坐标，坐标一律取 anitabi 的。

## 3. 工作流总览

```
[1 输入] → [2 切图] → [3 识别作品] → [4 拉候选地点] → [5 匹配地点] → [6 人工确认]
                                                                          ↓
[11 通知] ← [10 发布] ← [9 出图] ← [8 对齐裁剪] ← [7 原图] ←──────────────┘
```

节点类型：`code` 为代码节点（Python/Node），`http` 为 HTTP 请求，`llm` 为视觉模型，`human` 为暂停等待人工。

一次运行处理一批对比图。第 2 到第 8 步对每张图各跑一遍（循环或迭代节点），第 10、11 步整批只跑一次。

## 4. 节点说明

### 1 输入（表单 / webhook）
- **输入**：对比图（一张或多张）；作品名或 Bangumi ID（可选）；原图（可选，按文件名或上传顺序和对比图对应）。
- **输出**：`items[] = { comparison, original?, workHint? }`，带上本批次的 `batchId`。
- **失败处理**：校验格式。HEIC 先转 JPEG，动态照片只留静态帧。不支持的文件直接拒收，并告诉提交人原因。

### 2 切图（code）
- **做法**：找到对比图中间的分隔线（列方向的颜色或梯度突变；找不到就按中线切），切成 `animeHalf` 和 `realHalf`。
- **输出**：两张半图和切分位置。
- **失败处理**：如果切出的两半宽高比相差太大，或者找不到分隔线，就标记为 `needs_review`，交给第 6 步由人确认切分位置。

### 3 识别作品（http + llm）
- **跳过**：提交时已经给了作品名或 ID 时跳过这一步。作品名用 Bangumi 搜索换成 ID，复用 `scripts/lib/anitabi.ts` 的 `searchBangumi`。
- **首选 trace.moe**：调 `POST https://api.trace.moe/search?cutBorders&anilistInfo`，上传 `animeHalf` 的原始字节。匿名额度每月 100 次、并发 1，节点里要限流。
- **兜底用视觉 LLM**：trace.moe 的 similarity < 0.9 或没有结果时，让视觉模型根据画面给出候选作品名，再用 Bangumi 搜索换成 ID。
- **输出**：`{ bangumiId, title, confidence, via: "input" | "trace.moe" | "llm" }`。
- **注意**：trace.moe 返回的是 AniList 条目，集数跨季连续编号，要换算回 Bangumi 对应条目的季和集。

### 4 拉候选地点（http）
- **接口**：`GET https://api.anitabi.cn/bangumi/<id>/points/detail?haveImage=true`，必要时再拉 `/lite`。
- **输出**：`candidates[] = { pointId, name, cn, ep, image(h360), origin, originURL }`。
- **缓存**：同一作品在一个批次里只拉一次。
- **失败处理**：重试 3 次。作品下没有地点时，转到第 6 步，由人选择「trace.moe 截图 + 手动指定地点」或者跳过。

### 5 匹配地点（code 预筛 + llm 精排）
- **预筛（code）**：用 SIFT/ORB 内点数把 `animeHalf` 和所有候选截图比一遍，取前 10。这一步就是现在 agent 的做法，便宜、稳定。
- **精排（llm）**：把 `animeHalf`、`realHalf` 和前 10 张候选截图一起交给视觉模型。
- **提示词草稿**：

```
你会看到一张动画截图 A、一张实拍 R，以及若干编号的候选截图 C1..Cn（同一作品在 anitabi 上的地点截图）。
找出与 A 拍的是同一地点、同一角度的候选。看建筑轮廓、招牌、地面纹理、远景，不看人物和光线。
R 是实拍，可用来辅助判断。只输出 JSON，不要解释。
```

- **输出 schema**：

```json
{
  "top": [
    { "pointId": "string", "confidence": 0.0, "reason": "string" }
  ],
  "noMatch": false
}
```

  `top` 最多 3 项，按置信度从高到低排列；`confidence` 取 0 到 1；`noMatch` 表示候选里没有对应地点。
- **失败处理**：JSON 解析失败就重试 1 次，仍然失败则只用预筛结果。`noMatch` 为真时转到第 3 步的 trace.moe 搜帧分支，截图存到图床 `anime/`，`origin` 填 `"trace.moe"`。

### 6 人工确认（human）
- **自动通过**：LLM 第一名置信度 ≥ 0.85，预筛也是第一名，并且领先第二名足够多（阈值待定）。
- **其余情况**：把对比图和前 3 张候选截图发给作者，作者点选其中一张，也可以选「都不是」或「跳过」。
- **输出**：每张图最终确定的 `pointId`。
- **超时**：48 小时没有回复，本条就挂起，不影响同批其他图片。

### 7 原图（code）
- **有原图**：直接使用。按 EXIF 方向转正（检查倒置标记），读取 `DateTimeOriginal` 和时区偏移，时区设成 UTC+8 的要换算回拍摄地时间。
- **没有原图**：退回到对比图的 `realHalf`，`takenAt` 记为 `null`，并在通知里标明「替补图」。
- **取舍**：上传原图画质最好，但文件大、上传慢，而且原图带 GPS，所以只在处理节点内部使用，不落盘到任何公开位置，运行结束后删除。替补图省事，但分辨率和压缩质量都差一些。

### 8 对齐裁剪（code，不用 LLM）
- **做法**：用 OpenCV 的 SIFT 加 FLANN 匹配原图和 `realHalf`，再用 RANSAC 估计相似变换（`estimateAffinePartial2D`），得到旋转角、缩放和平移，然后把 `realHalf` 的四个角映射回原图，算出裁剪框。这样放大裁切和宽幅取景都能还原。
- **输出**：`{ angle, crop: [x, y, w, h], inliers }`。
- **失败处理**：内点数少于 30，或者旋转角超过 15°，就当作对齐不可信，交给第 6 步人工处理，可以选「不裁剪」或「用替补图」。
- **不用单应矩阵**：照片是同一台相机拍的同一张图，相似变换就够了；单应矩阵容易引入透视变形。

### 9 出图（code）
- **工具**：sharp 或 Pillow。转成 sRGB，去掉全部元数据。
- **规格**：
  - `tabi/<bangumiId>/<pointId>.webp`：长边 1280，q80
  - `mid/`：长边 640，q80
  - `thumb/`：长边 320，q75
- **不放大**：原图本身比目标尺寸小时，按原尺寸输出。
- **自检**：输出后再读一遍文件，确认没有 EXIF/GPS，有就让本条失败。
- **同时生成总览图**：左边 anitabi 截图，右边处理后的实拍，供第 11 步使用。

### 10 发布（GitHub + http）
1. **推图床**：用一次 Git Data API commit（blobs → tree → commit → 更新 ref）把本批所有图片推到 `QiYuOr2/blog-image@master`。只新增文件，路径已存在就跳过。
2. **jsDelivr 检查**：逐个请求 `https://cdn.jsdelivr.net/gh/QiYuOr2/blog-image@master/<path>`。返回 403 或 404 时调用 `https://purge.jsdelivr.net/gh/QiYuOr2/blog-image@master/<path>`，等待后重试，最多 5 轮。仍有地址失败就中止，不写地图数据，否则线上会裂图。
3. **写数据**：读取最新的 `src/data/spots.json`，只追加 id 不存在的地点；字段按 `Spot` 填写，`source: "anitabi"`，坐标取 anitabi 的。新作品属于已有系列时，把 Bangumi ID 加进 `src/data/works.json` 对应条目；新系列就新建条目。
4. **推地图**：commit 到 `QiYuOr2/tabi@main`。如果 ref 已经变了，重新读取、重新追加、再提交，不 force push。commit 说明不写坐标。
5. **等部署**：轮询 Vercel 部署状态，或者等待一段固定时间后再请求线上页面。

### 11 通知（http）
- **内容**：线上链接 `https://tabi.qiyuor2.me`、本批新增的地点数、压缩后的并排总览图（几百 KB 以内）。替补图、弱匹配、被跳过的条目单独列出。
- **渠道**：平台自带通知，或者 webhook 到常用的聊天工具。

## 5. 平台选择

| 平台 | 结论 | 理由 |
| --- | --- | --- |
| n8n（自部署） | 推荐 | Code 节点能跑 Node/Python，可以装 OpenCV 和 sharp；有 Wait/表单节点用于人工确认；凭证集中管理 |
| Dify（自部署） | 可选 | LLM 节点和提示词管理做得更好；重度图像处理建议拆成独立的 HTTP 小服务 |
| Coze | 不推荐 | 代码节点限制多，难以运行 OpenCV，处理大文件和管理 GitHub 凭证都不方便 |

建议把第 2、8、9 步打包成一个独立的小服务（容器，HTTP 接口），由工作流调用。这样以后换平台时，图像处理部分不用重写。

## 6. 密钥与权限

- **GitHub**：fine-grained token，只授权 `QiYuOr2/tabi` 和 `QiYuOr2/blog-image` 两个仓库，权限为 Contents: read/write，其他一律不给。
- **LLM**：一个视觉模型的 API key，设置用量上限。
- **trace.moe**：匿名额度够用就不需要 key，需要更多额度时再申请。
- 所有密钥只放在平台的凭证库里，不写进仓库，也不出现在日志里。

## 7. 幂等与重跑

- 以 `<bangumiId>-<pointId>` 作为幂等键。`spots.json` 里已有的 id 直接跳过；图床上已有的路径不覆盖。同一个 pointId 要放第二张图时，必须显式标记 `-2`。
- 每个节点的输出都按 `batchId` 缓存，失败后从断点重跑，不会重复调用 LLM 和 trace.moe。
- 发布严格按「先图床、再验证、后数据」的顺序执行，任何一步失败，后面的步骤都不执行。

## 8. 成本估算（推测）

- **LLM**：每张对比图大约 1 到 2 次视觉调用，每次附带 10 张左右的小图，每批二三十张图的花费很低。预筛能大幅减少候选数量，是省钱的关键。
- **trace.moe**：只在识别作品和 `noMatch` 时调用，匿名额度通常够用。
- **其他**：GitHub、jsDelivr 和 Vercel 都在免费额度内。自部署平台需要一台常驻的小机器。

## 9. 不用 AI 的兜底方案

做一个本地入库网页（例如 `pnpm intake`）：输入作品后列出 anitabi 的全部地点截图，由人点选；拖入原图后，在网页里对照截图旋转和框选裁剪；导出和发布直接复用第 9、10 步的代码。工作流的模型节点不可用时，就退回这个工具。

## 10. 待定问题

- 第 6 步自动通过的阈值，要先拿已入库的约 190 个地点回测，再确定。
- 原图怎么进工作流：网页上传、网盘目录，还是本地脚本推送？
- 通知走什么渠道？人工确认在哪里完成：平台自带页面，还是聊天工具里的按钮？
- 现有 `scripts/process-photos.ts` 是改造成服务，还是另写 Python 版本？
- 旧作品的 JPEG 图片要不要统一成 WebP？在作者决定之前不动。

## 11. TODO

**阶段 0：准备**
- [ ] 用已入库的数据做一个回测集（对比图、正确的 pointId），给第 5、6 步调阈值用
- [ ] 确定平台（n8n 或 Dify），确定部署位置
- [ ] 申请 fine-grained GitHub token 和 LLM key

**阶段 1：图像服务**
- [ ] 切图接口（第 2 步）
- [ ] 对齐裁剪接口（第 8 步），用回测集验证裁剪框
- [ ] 出图接口（第 9 步），包含 EXIF 自检和总览图

**阶段 2：匹配**
- [ ] 识别作品节点：trace.moe 限流加 LLM 兜底
- [ ] anitabi 候选拉取和缓存
- [ ] 预筛加 LLM 精排，提示词和 JSON schema 定稿，在回测集上统计准确率

**阶段 3：发布**
- [ ] blog-image 单次 commit、jsDelivr 检查和 purge
- [ ] spots.json / works.json 追加，处理 ref 冲突时的重试
- [ ] 部署确认和通知

**阶段 4：上线**
- [ ] 人工确认节点接入通知渠道
- [ ] 用一批真实照片端到端跑通，和 agent 的结果对比
- [ ] 更新 `docs/skills/pilgrimage-photo-intake/SKILL.md`，改成「默认走工作流，agent 只处理疑难条目」
