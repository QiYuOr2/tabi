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
| n8n 社区版（自部署） | 推荐 | Code 节点能跑 Node/Python，自部署可放开外部模块；有 Wait/表单节点用于人工确认；凭证集中管理。默认在作者本地电脑上用 Docker 按需启动，费用为 0（见第 8 节） |
| Dify 社区版（自部署） | 可选 | LLM 节点和提示词管理做得更好，但组件多（十几个容器，最低 2 核 4 GB），本地按需启停偏重；重度图像处理同样要拆成独立服务 |
| n8n Cloud / Dify Cloud | 不推荐 | 按月付费（€20 起 / $590 每年），而且云端代码节点装不了 OpenCV，还是要另找地方跑图像服务；原图也得先传上云 |
| Coze | 不推荐 | 代码节点只能用少数内置依赖（JS 仅 dayjs、lodash，Python 仅 numpy 等），单节点 60 秒、入参 2 MB，跑不了 OpenCV，也处理不了原图 |

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

## 8. 费用对比与推荐

> 价格均为 as of 2026-11，按官网标价（不含税），来源见本节末尾。用量假设：每月 1～4 批、每批 5～40 张，按每月 100 张上限计算。标注「已核实」的数字来自官网页面，「推测」为按公开计费规则估算。

### 8.1 每张照片的模型用量（推测）

- **第 5 步精排**：动画半张、实拍半张，加预筛后的 10 张候选截图，共 12 张图，每张先缩到 384px 以内，再加约 500 token 提示词、约 300 token 输出。按各家图片计费规则，输入约 2,300～3,600 token。
- **第 3 步兜底**：只在没给作品名且 trace.moe 不确定时调用。按 30% 的照片需要计算，每次 1 张图，用量很小。
- **不做预筛**：把 60 张候选全塞进一次调用，输入涨到约 1.6 万 token，费用约是预筛时的 3 倍，仍然很低。预筛的价值主要在于提高准确率，省钱是次要的。
- **其他节点**：第 8、9 步的 OpenCV 和出图、第 10 步的 GitHub API 都不花模型费用。

### 8.2 视觉模型单价与月费

| 模型 | 输入 / 输出（每百万 token） | 每张约 | 每月 100 张约 | 免费额度 |
| --- | --- | --- | --- | --- |
| Gemini 3.1 Flash-Lite | $0.25 / $1.50（已核实） | $0.0014 | $0.14 | 免费层每天约 500 次请求、每分钟 15 次（第三方实测，以 AI Studio 显示为准） |
| Gemini 3.5 Flash-Lite | $0.30 / $2.50（已核实） | $0.0020 | $0.20 | 同上 |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40（已核实） | $0.0005 | $0.05 | 官方说明 2.5 系列只对以前用过的账号开放，新账号不一定能用 |
| Claude Haiku 5.5 | $0.10 / $0.50（已核实） | $0.0005 | $0.05 | 无 |
| GPT-5.4-nano | $0.20 / $1.25（已核实） | $0.0010 | $0.10 | 无 |
| Qwen3-VL-Plus（国际站） | $0.20 / $1.60（已核实） | $0.0010 | $0.10 | 新加坡区开通后 90 天内赠 100 万 token |
| GPT-4.1-mini | $0.40 / $1.60（已核实） | $0.0019 | $0.19 | 无 |
| Grok 4.3 | $1.25 / $2.50（已核实） | $0.0055 | $0.55 | 无；图片 token 数按 258/张推测 |
| GPT-4o-mini | $0.15 / $0.60（已核实） | 约 $0.005 | 约 $0.5 | 无；单价低，但每张图按 2,833 token 起计，算下来反而贵 |

- 每张的花费都是推测值，开了思考模式时输出 token 会多一些。即使把用量放大 3 倍，所有方案每月也都在 $2 以内。
- **trace.moe**：匿名每月 100 次、并发 1（已核实，来自 `api.trace.moe/me` 的返回）。只在第 3 步和 `noMatch` 时调用，够用。
- **Gemini 免费层**：请求会被用于改进 Google 的产品。发送的只是动画截图和本来就要公开的实拍缩小图，去掉了元数据、没有 GPS，可以接受。介意的话就开通付费，每月约 $0.15。

### 8.3 平台方案排序（每月总费用 = 平台 + 计算 + 模型）

| 排名 | 方案 | 每月费用 | 能否满足要求（人工确认 / OpenCV 和 sharp / GitHub 密钥） | 主要限制 |
| --- | --- | --- | --- | --- |
| 1 | **n8n 社区版，本地电脑 Docker 按需启动** + Gemini 3.1 Flash-Lite 免费层 | **$0**（付费兜底 ≤ $0.2） | 全部满足：Form/Wait 节点做确认，图像服务容器在同一台机器上，凭证存 n8n 本地 | 只能在电脑开着时跑；手机上提交不了 |
| 1 | 本地脚本或 CLI，不用平台（即第 9 节的方案加上模型调用） | $0（模型同上） | 满足，在终端或本地网页里确认 | 没有可视化编排，改流程要改代码 |
| 3 | GitHub Actions（公开仓库用标准 runner 免费）+ 脚本，在 Issue 或 PR 评论里确认 | $0（模型同上） | 基本满足，token 放仓库 Secrets | 输入要放进公开仓库或 Issue 附件，**原图必须先在本地去掉 GPS**；评论触发、排队，反馈慢 |
| 4 | n8n 或 Dify 社区版，部署在 Oracle Cloud Always Free（Ampere A1，共 2 OCPU、12 GB） | $0 | 满足，常驻在线 | 2026 年 6 月额度已减半；注册要绑卡，热门区域常没有空余资源；闲置实例可能被回收（推测）；要自己维护和加 HTTPS |
| 5 | Dify Cloud Sandbox（免费） | $0 | 不满足：云端代码节点跑不了 OpenCV，要另外部署图像服务 | 200 条消息额度是一次性的（可以改用自己的 key），每月 5,000 次 API 调用、3,000 次触发；原图要传上云 |
| 6 | Vercel Hobby Functions 跑图像服务 | $0 | 只能做图像服务，不是工作流平台 | 请求体上限 4.5 MB，传不了原图；包体上限 250 MB（大函数 Beta 最高 5 GB），单次最长 300 秒，每月 4 CPU 小时；仅限个人非商业用途 |
| 7 | Coze 免费版（coze.cn 每天登录领 1,500 积分，当天有效；coze.com 每天 10 credits） | $0 | 不满足，原因见第 5 节 | 积分用完就停服 |
| 8 | n8n 社区版，部署在 Hetzner 等廉价 VPS | 约 €6/月起 | 满足，常驻在线 | 要付费，也要自己维护 |
| 9 | n8n Cloud Starter | €20/月（按年付） | 不满足：云端 Code 节点不能装外部模块，图像服务要另外部署 | 每次执行最长 5 分钟，并发 5 |
| 10 | Dify Cloud Professional | $590/年（约 $49/月） | 同 Dify Sandbox | 这个用量用不上它的额度 |

### 8.4 推荐

**默认方案：n8n 社区版在作者本地电脑上用 Docker 按需启动，配 Gemini 3.1 Flash-Lite 免费层。预计每月 $0；关闭免费层、改用付费时每月约 $0.15，上限按 $1 设。**

- **适合低频使用**：每月最多 4 批，不需要 24 小时在线的服务器。原图本来就在本地，不用上传到任何云端，GPS 也就不会离开本机。
- **图像服务**：第 2、8、9 步做成同一台机器上的容器（Python OpenCV 加 Pillow 或 sharp），n8n 通过 HTTP 调用。
- **人工确认**：用 n8n 的 Form 或 Wait 节点，在本地网页上点选。
- **发布**：第 10 步用 GitHub fine-grained token，存在 n8n 的凭证库里。
- **模型兜底**：免费层超限或不想让数据用于改进产品时，切到付费的 Gemini 3.1 Flash-Lite 或 Claude Haiku 5.5，每月都不到 $0.2。
- **以后想在手机上随时提交**：再把同一套 compose 迁到 Oracle Always Free，每月 $0；资源抢不到就用廉价 VPS，约 €6/月。
- **不推荐 Cloud 版**：两家 Cloud 版都要额外部署图像服务，花钱反而更多。Coze 跑不了这条流程。

### 8.5 价格来源（as of 2026-11）

- n8n 定价：https://n8n.io/pricing/
- n8n Code 节点外部模块（自部署配置）：https://docs.n8n.io/hosting/configuration/configuration-examples/modules-in-code-node/
- Dify 定价：https://dify.ai/pricing
- Dify 自部署配置要求：https://docs.dify.ai/en/getting-started/install-self-hosted/docker-compose
- 扣子积分与套餐：https://docs.coze.cn/coze_pro_credits 、https://docs.coze.cn/guides_20260119_coze_premium_upgraded
- 扣子代码节点与工作流限制：https://docs.coze.cn/guides_code_node 、https://docs.coze.cn/guides_workflow_limits
- Coze 国际版 credits：https://docs.coze.com/guides/message_credits
- Gemini API 定价：https://ai.google.dev/gemini-api/docs/pricing
- Gemini 图片 token 计算：https://ai.google.dev/gemini-api/docs/image-understanding
- Gemini 模型下线计划：https://ai.google.dev/gemini-api/docs/deprecations
- Gemini 免费层限额（第三方实测，官方只在 AI Studio 显示）：https://aiplug.work/en/blog/gemini-free-tier-limits
- OpenAI 定价：https://developers.openai.com/api/docs/pricing
- OpenAI 图片 token 计算：https://developers.openai.com/api/docs/guides/images-vision
- Anthropic 定价：https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic 图片 token 计算：https://platform.claude.com/docs/en/build-with-claude/vision
- xAI 定价：https://docs.x.ai/docs/models
- 阿里云百炼（Qwen）定价：https://www.alibabacloud.com/help/en/model-studio/model-pricing
- trace.moe API：https://soruly.github.io/trace.moe-api/
- GitHub Actions 计费：https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Vercel Functions 限制：https://vercel.com/docs/functions/limitations
- Vercel Hobby 套餐：https://vercel.com/docs/plans/hobby
- Oracle Always Free：https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Hetzner Cloud：https://www.hetzner.com/cloud/

## 9. 不用 AI 的兜底方案

做一个本地入库网页（例如 `pnpm intake`）：输入作品后列出 anitabi 的全部地点截图，由人点选；拖入原图后，在网页里对照截图旋转和框选裁剪；导出和发布直接复用第 9、10 步的代码。工作流的模型节点不可用时，就退回这个工具。

## 10. 待定问题

- 第 6 步自动通过的阈值，要先拿已入库的约 190 个地点回测，再确定。
- 原图怎么进工作流：按第 8 节的推荐在本地运行时，直接从本地目录读取；以后迁到云端时再定（网页上传还是网盘目录）。
- 通知走什么渠道？人工确认在哪里完成：平台自带页面，还是聊天工具里的按钮？
- 现有 `scripts/process-photos.ts` 是改造成服务，还是另写 Python 版本？
- 旧作品的 JPEG 图片要不要统一成 WebP？在作者决定之前不动。

## 11. TODO

**阶段 0：准备**
- [ ] 用已入库的数据做一个回测集（对比图、正确的 pointId），给第 5、6 步调阈值用
- [ ] 按第 8 节，在作者本地电脑上用 Docker Compose 搭好 n8n 社区版和图像服务容器（按需启停）
- [ ] 申请 fine-grained GitHub token 和 Gemini API key（先用免费层），在 AI Studio 确认项目的实际免费额度
- [ ] 准备付费兜底：开通计费并设用量上限（$1/月），或者备一个 Claude Haiku 5.5 的 key

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
