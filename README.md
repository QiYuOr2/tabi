# 巡礼地图 tabi

把动画巡礼的对比图（动画截图 + 实拍）标在地图上，按作品分组显示。

- 工具链：[Vite+](https://viteplus.dev)（`vp`）
- 页面：Vue 3 + TypeScript + UnoCSS
- 地图：[MapLibre GL JS](https://maplibre.org/) + [OpenFreeMap](https://openfreemap.org/) 公共瓦片（无 key）
- 巡礼地点数据：[anitabi](https://anitabi.cn) 开放 API（截图按 CC BY-NC-SA 4.0，展示时标注来源）

技术方案和待确认事项见 [docs/plan.md](docs/plan.md)。

## 开发

需要 Node 24+ 和 pnpm。

```bash
pnpm install
pnpm dev                     # 等于 vp dev
pnpm build                   # vue-tsc -b && vp build
pnpm exec vp check           # 格式 + lint + 类型检查
```

不需要地图 token。不设置环境变量时使用 OpenFreeMap 的 Liberty 样式。

### 环境变量

| 变量                 | 必填 | 说明                                                                                                                                                   |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MAP_STYLE_URL` | 否   | MapLibre 样式 URL。默认 `https://tiles.openfreemap.org/styles/liberty`。也可换成 OpenFreeMap 官方的 bright、positron、dark、fiord，见 `.env.example`。 |

底图署名由 MapLibre 根据样式来源自动显示（OpenFreeMap、OpenMapTiles、OpenStreetMap），不要拿掉。地名优先用日文，没有日文时再用简体中文，避免英文或罗马字占主位，原因见 plan.md。

## 数据

地点数据在 `src/data/spots.json`，类型定义在 `src/types/spot.ts`。

`source` 表示坐标来源：`exif`（照片自带 GPS）、`anitabi`（匹配 anitabi 地标）、`geocode`（地理编码）、`manual`（手动标注）。

## 脚本

```bash
# 读取原图的 GPS 和拍摄时间
# 有 GPS → photos/imported-spots.json；没有 → photos/pending.json
node scripts/import-photos.ts ./photos/2026-05 --anime 吹响吧！上低音号 --bangumi 115908

# 在 anitabi 上按作品 + 地点名模糊匹配，输出候选和坐标
node scripts/match-anitabi.ts 115908 宇治橋
node scripts/match-anitabi.ts 上低音号 京都音乐厅 --top 3 --json
```

脚本不会改 `src/data/spots.json`，确认结果后再手动合并。原图放在 `photos/`，已被 git 忽略。

注意：anitabi 文档里地标有 `geo` 坐标字段，但目前接口返回里没有，脚本会改从 Google Maps 来源的 `originURL` 里解析坐标，解析不到的需要手动标注。
