# 巡礼地图技术方案（草案）

> 状态：脚手架在分支上。底图已从 Mapbox 改为 MapLibre GL JS + OpenFreeMap，还没部署，没改 DNS，没动其它仓库或 Vercel 项目。
> 标注说明：**[已验证]** = 实际跑过；**[推测]** = 还没验证。
> 原先脚手架里的 EXIF / anitabi 结论来自 2026-11-02 另一台机器。底图条款和 OpenFreeMap 瓦片字段是这次核对的。

## 1. 目标

把巡礼对比图（动画截图 + 实拍）标到地图上，按作品分组显示，以后部署到 `tabi.qiyuor2.me`。

## 2. 技术栈

| 部分   | 选择                                               | 说明                                                                                               |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 工具链 | Vite+ 1.4.0（`vite-plus`，`vp` CLI）               | **[已验证]** `vp create vite -- --template vue-ts` 创建，`vp dev` / `vp build` / `vp check` 均通过 |
| 页面   | Vue 3 + TypeScript + UnoCSS（presetWind3 + reset） |                                                                                                    |
| 地图   | MapLibre GL JS + OpenFreeMap 公共样式              | 无 key。默认 Liberty，可用 `VITE_MAP_STYLE_URL` 换官方其它样式                                     |
| 数据   | 仓库内 `src/data/spots.json`                       | 先不接数据库                                                                                       |
| 脚本   | Node 24 直接跑 `.ts`（内置 type stripping）        | 不需要 tsx                                                                                         |

## 3. 数据结构

见 `src/types/spot.ts`：

```ts
interface Spot {
  id: string;
  bangumiId: number | null;
  animeName: string;
  pointName: string;
  lat: number;
  lng: number;
  animeImage: string | null;
  photo: string | null;
  takenAt: string | null;
  source: "exif" | "anitabi" | "geocode" | "manual";
  anitabiPointId: string | null;
  origin?: string | null;
  originURL?: string | null;
}
```

`takenAt` 存 EXIF 的拍摄地本地时间；照片带 `OffsetTimeOriginal` 时附上偏移（如 `+09:00`），否则不带时区，避免被跑脚本的机器时区改写。

## 4. 定位流程

1. **EXIF**：`node scripts/import-photos.ts <目录>` 用 exifr 读 GPS 和拍摄时间。有坐标 → `source: "exif"`；没坐标 → `photos/pending.json`。**[已验证]** 用两张合成测试图（一张带 GPS、一张不带）跑通。
2. **anitabi 匹配**：`node scripts/match-anitabi.ts <bangumiId|作品名> <地点名>`，拉 `points/detail` 做模糊匹配（NFKC 归一化 + 包含 + bigram Dice），输出候选和坐标。**[已验证]** `115908 宇治橋`、`115908 京都音乐厅` 都能命中。
3. **地理编码 / 手动**：anitabi 上没有或没坐标的，以后再选一个允许的地理编码（不再用 Mapbox Geocoding），或直接手动标。标注页还没做。

### anitabi 坐标字段（重要）

- 官方文档（[api.md](https://github.com/anitabi/anitabi.cn-document/blob/main/api.md)）写的是 `geo: [lat, lng]`，`litePoints` 和 `points/detail` 都有。
- **[已验证]** 2026-11-02 实测 `/bangumi/115908/lite`、`/bangumi/115908/points/detail`（带不带 `haveImage`，改 UA/Referer 都试过）、`/bangumi/126461/points/detail` 的返回里**都没有 `geo` 字段**，只有 `id, name, cn(仅 lite), image, ep, s, origin, originURL`。作品级的 `geo`（作品中心点）还在。
- 回退方案：来源是 Google Maps 的地标，`originURL` 里有 `ll=lat,lng`，脚本从这里解析（115908 的 84 个地标里有 35 个能拿到）。其余地标没有坐标，需要手动标注。
- 顺带：`anitabi-mcp-server` 的 zod schema 把 `geo` 设为必填，按现在的返回可能会校验失败。**[推测]** 没实际跑。
- anitabi 截图按 CC BY-NC-SA 4.0 共享，展示时要标 `origin` 并能跳转 `originURL`，卡片里已经这样做了。

## 5. 底图：放弃 Mapbox

### 5.1 为什么不用 Mapbox

原先脚手架用的是 mapbox-gl 3.34.1，并试过把瓦片转到自己的服务上。结论是这条路不该继续：

- **[已验证]** `transformRequest` 能改写样式、瓦片、字体、雪碧图，但 GL JS 还会**直连** `api.mapbox.com/map-sessions/v1`（计费鉴权）和 `events.mapbox.com`。这两个请求不走 `transformRequest`。token 无效时画布会被清空，并报需要有效的 Mapbox access token。SDK 注明改这段逻辑违反 Mapbox 条款。
- 所以浏览器里必须放一个 public token（`pk.*`）。token 写在前端就能被拿走，URL 限制也挡不住非浏览器调用，有被刷费用的风险。
- **[已验证，条款原文]** Mapbox Product Terms（2026-07-21 版）2.8.1：地图内容只能缓存在发起请求的终端上，最多 30 天，且不得通过代理分发。2.8.3：需要用 Qualified Renderer，且不能干扰它发送的信息。

因此仓库里不再有 `mapbox-gl`、Mapbox token、瓦片中转环境变量或相关代码。也不在别的项目里加 `/mapbox/*` 代理。

### 5.2 现在的方案：MapLibre + OpenFreeMap

[OpenFreeMap](https://openfreemap.org/) 提供可直接给 MapLibre 用的公共矢量样式，数据来自 OpenStreetMap。默认：

`https://tiles.openfreemap.org/styles/liberty`

可用 `VITE_MAP_STYLE_URL` 换成官方的 bright、positron、dark、fiord。样式 URL 只在前端使用，没有密钥。

**条款（2026-11-02 核对 [首页](https://openfreemap.org/) 和 [Terms of Service](https://openfreemap.org/tos/)，条款标明 Last Updated: October 14, 2026）：**

- 公共实例免费，不限地图浏览次数和请求数，不用注册，没有用户库，没有 API key，没有 cookie。明确允许商用。
- 服务按现状提供，不保证可用性，维护者可以不经通知停止服务。没有 SLA。
- 署名是必须的。用 MapLibre 时，署名会随样式自动加上，不需要再手写。TileJSON（`https://tiles.openfreemap.org/planet`）里的署名是：OpenFreeMap、© OpenMapTiles、Data from OpenStreetMap。页面上保留 MapLibre 的 attribution 控件，不要盖住或关掉。
- 非 MapLibre 客户端、印刷或视频要自行写上：`OpenFreeMap © OpenMapTiles Data from OpenStreetMap`。
- 离线下载另有限制：每次最多 3000 个瓦片或 50 MB、最多 4 个并行请求，并带能识别应用的 User-Agent。更大的下载要事先联系。本项目是在线看图，不做区域下载。
- 把公共实例接进网站或应用的人需要年满 18 岁；只是打开页面看地图的访客不受这条限制。
- 请求会经过 Cloudflare CDN。

这个用法（浏览器里用 MapLibre 加载官方样式 URL，保留自动署名，不批量扒瓦片）在上述条款里是允许的。

**[已验证]** 这次在 Node 24.22.2、pnpm 12.16.1 上重新跑过 `pnpm exec vp check` 和 `pnpm build`。浏览器打开默认 Liberty 样式后，日本全景的瓦片能画出来，右下角署名是 `MapLibre | OpenFreeMap © OpenMapTiles Data from OpenStreetMap`。能看到「日本」「宇治市」这类中日文，而不是只有 Japan / Kyoto。点示例图钉会打开卡片。bright、positron、dark、fiord 这四个样式没有逐个打开。

**标注语言：** 官方 Liberty 样式默认是「拉丁文 + 非拉丁文」两行，英文/罗马字会占上面一行。样式加载后，把引用了 `name` 的 symbol 图层 `text-field` 改成按这个顺序取第一个有值的字段：`name:ja` → `name:zh-Hans` → `name:zh` → `name:nonlatin` → `name`。路名编号（`ref`）不改。

日文排在中文前面，是因为巡礼地点在日本：`name:ja` 和路牌一致。OpenMapTiles 里日本车站的 `name:zh` 经常是「××站」这种译名，直接优先中文会和实景对不上。没有日文的地方（例如中国境内）会落到简体中文。字形用样式自带的 Noto Sans，CJK 字形文件可以取到。

### 5.3 备选：日本范围 PMTiles

如果 OpenFreeMap 公共实例不稳定，或者以后不想依赖它，可以改成日本范围的 PMTiles，放到 Cloudflare R2，MapLibre 用 PMTiles 协议读。z14 实测大约 1.7GB。这次不实现，也不建 R2。

## 6. 图片

- 原图放 `photos/`（已在 `.gitignore` 里忽略，原图带 GPS，不进仓库）。
- 线上图片存放：`blog-image` 图床或 Vercel Blob，待定。上传前要缩图并**去掉 EXIF**（GPS 已经提取进 spots.json，没必要再公开原始元数据）。

## 7. 部署（都要先确认，这次没做）

1. 仓库 `QiYuOr2/tabi` 已建。改动走 PR，合并前先看预览。
2. Vercel 项目还没建。建的时候不需要地图 token。
3. 绑定 `tabi.qiyuor2.me` 需要在 DNS 加一条 `tabi` CNAME，不要动现有记录。这次没有改 DNS，也没有改任何 Vercel 项目。

## 8. 待办

- [x] 底图不用 Mapbox，改为 MapLibre + OpenFreeMap
- [ ] 手动标注页（拖图钉、确认 anitabi 候选）
- [ ] 图片缩图 + 去 EXIF + 上传脚本
- [ ] 作品多了以后做聚合（cluster）
- [ ] 部署到 Vercel，并绑定 `tabi.qiyuor2.me`
- [ ] 若公共瓦片不够稳，再评估日本范围 PMTiles（z14 约 1.7GB，Cloudflare R2）
