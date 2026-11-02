import { setWorkerUrl, type ExpressionSpecification, type Map } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

/** OpenFreeMap 官方 Liberty 样式。无 key。可用 VITE_MAP_STYLE_URL 覆盖。 */
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL?.trim() || DEFAULT_MAP_STYLE_URL;

/**
 * 地名优先用中日文，而不是英文或罗马字。
 *
 * OpenMapTiles 里日本的 `name:ja` 是路牌上的本地名。`name:zh` 经常是译名
 * （车站会变成「××站」），所以日文排在简体中文前面。没有日文时再用中文，
 * 最后才回退到本地名。路牌编号（`ref`）不动。
 */
export const CJK_TEXT_FIELD = [
  "coalesce",
  ["get", "name:ja"],
  ["get", "name:zh-Hans"],
  ["get", "name:zh"],
  ["get", "name:nonlatin"],
  ["get", "name"],
] as const satisfies ExpressionSpecification;

let workerReady = false;

/** Vite 下把 MapLibre worker 指到打包后的 URL，避免运行时找不到 worker。 */
export function ensureMapWorker() {
  if (workerReady) return;
  setWorkerUrl(workerUrl);
  workerReady = true;
}

export function preferCjkLabels(map: Map) {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    if (layer.type !== "symbol") continue;
    const field = map.getLayoutProperty(layer.id, "text-field");
    if (field == null) continue;
    const serialized = typeof field === "string" ? field : JSON.stringify(field);
    if (!serialized.includes("name")) continue;
    if (serialized.includes('"name:ja"') && serialized.includes('"name:zh-Hans"')) continue;
    map.setLayoutProperty(layer.id, "text-field", CJK_TEXT_FIELD);
  }
}
