# 巡礼地图 tabi

把动画巡礼的对比图（动画截图 + 实拍）标在地图上，按作品分组显示。

- 工具链：[Vite+](https://viteplus.dev)（`vp`）
- 页面：Vue 3 + TypeScript + UnoCSS
- 地图：[MapLibre GL JS](https://maplibre.org/) + [OpenFreeMap](https://openfreemap.org/) 公共瓦片（无 key）
- 巡礼地点数据：[anitabi](https://anitabi.cn) 开放 API（截图按 CC BY-NC-SA 4.0，展示时标注来源）

技术方案和待确认事项见 [docs/plan.md](docs/plan.md)。

## 仓库

pnpm workspace。站点在 `apps/web`，照片脚本在 `packages/intake`（`@tabi/intake`）。`docs/` 和 `photos/`（原图收件，不进仓库）留在仓库根目录。

```
apps/web            Vue 站点
packages/intake     照片脚本
docs/               方案和技能
photos/             原图收件
```

## 开发

需要 Node 24+ 和 pnpm。在仓库根目录：

```bash
pnpm install
pnpm dev                     # apps/web：vp dev
pnpm build                   # apps/web：vue-tsc -b && vp build
pnpm check                   # apps/web：vp check；intake：tsc --noEmit
```

不需要地图 token。不设置环境变量时使用 OpenFreeMap 的 Liberty 样式。

### 环境变量

| 变量                 | 必填 | 说明                                                                                                                                                   |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MAP_STYLE_URL` | 否   | MapLibre 样式 URL。默认 `https://tiles.openfreemap.org/styles/liberty`。也可换成 OpenFreeMap 官方的 bright、positron、dark、fiord，见 `apps/web/.env.example`。把示例复制成 `apps/web/.env.local` 再生效。 |

底图署名由 MapLibre 根据样式来源自动显示（OpenFreeMap、OpenMapTiles、OpenStreetMap），不要拿掉。地名优先用日文，没有日文时再用简体中文，避免英文或罗马字占主位，原因见 plan.md。

## 数据

地点数据在 `apps/web/src/data/spots.json`，类型定义在 `apps/web/src/types/spot.ts`。

`source` 表示坐标来源：`exif`（照片自带 GPS）、`anitabi`（匹配 anitabi 地标）、`geocode`（地理编码）、`manual`（手动标注）。

## 脚本

命令在仓库根目录运行，路径相对仓库根目录。也可以在 `packages/intake` 里用 `node src/import-photos.ts`、`node src/match-anitabi.ts`、`node src/process-photos.ts`，路径同样相对仓库根目录。

```bash
# 读取原图的 GPS 和拍摄时间
# 有 GPS → photos/imported-spots.json；没有 → photos/pending.json
pnpm import-photos -- ./photos/2026-05 --anime 吹响吧！上低音号 --bangumi 115908

# 在 anitabi 上按作品 + 地点名模糊匹配，输出候选和坐标
pnpm match -- 115908 宇治橋
pnpm match -- 上低音号 京都音乐厅 --top 3 --json

# 缩图并去掉 EXIF，输出 blog-image 用的大图和缩略图
pnpm photos:process -- ./photos --bangumi 100444 DSC001.jpg=51i51ynk8
pnpm photos:process -- --spots photos/imported-spots.json --bangumi 100444
pnpm photos:process -- --map photos/map.json
pnpm photos:process -- --map photos/map.json --format webp
```

`process-photos` 会先读原图的 GPS 和 `DateTimeOriginal`（和 `import-photos` 同一套逻辑），再按 EXIF 方向转正。大图最长边 1280、JPEG 质量 82；缩略图从大图再缩到最长边 320、质量 78。都不放大，渐进式，mozjpeg，sRGB，去掉全部元数据。写完会再检查输出里没有 EXIF/GPS。加 `--format webp` 时改出 WebP（大图质量 80，缩略图质量 75），文件名和 jsDelivr 地址的扩展名变成 `.webp`；不加时仍是 JPEG。

输出名优先用命令行的 `原文件名=输出名` 和 `--map`，否则用 `--spots` 里的 `anitabiPointId`，没有就用 spot id。未写 `--spots` 时，如果 `photos/imported-spots.json` 存在会自动读。`--map` 的格式是 `{ "bangumiId": 100444, "files": { "DSC001.jpg": "51i51ynk8" } }`。

文件写到 `dist-photos/<bangumiId>/<输出名>.jpg` 和 `dist-photos/<bangumiId>/thumb/<输出名>.jpg`（`dist-photos/` 不进仓库）。终端会打印 jsDelivr 地址，以及可以填进 `spots.json` 的 `photo` / `photoThumb`。处理前读到的 GPS 和拍摄时间写在 `dist-photos/capture.json`。目录里对不上输出名的照片会跳过，命令以非 0 退出。

脚本不会改 `apps/web/src/data/spots.json`，确认结果后再手动合并。原图放在仓库根的 `photos/`，已被 git 忽略。

注意：anitabi 文档里地标有 `geo` 坐标字段，但目前接口返回里没有，脚本会改从 Google Maps 来源的 `originURL` 里解析坐标，解析不到的需要手动标注。
