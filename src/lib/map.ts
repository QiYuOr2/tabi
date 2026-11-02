import {
  setWorkerUrl,
  type ExpressionSpecification,
  type FilterSpecification,
  type Map,
} from "maplibre-gl";
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

/**
 * 整层关掉的底图符号。
 * 道路编号盾牌、小路和步道名、单行道箭头。
 * 当前 OpenFreeMap Liberty 没有门牌号层；若以后样式带上 housenumber，也会关掉。
 */
export const QUIET_BASEMAP_LAYER_IDS = [
  "highway-shield-non-us",
  "highway-shield-us-interstate",
  "road_shield_us",
  "highway-name-path",
  "highway-name-minor",
  "road_one_way_arrow",
  "road_one_way_arrow_opposite",
] as const;

const QUIET_BASEMAP_LAYER_SET = new Set<string>(QUIET_BASEMAP_LAYER_IDS);

/**
 * 商店、餐饮和其他 POI 与铁路车站挤在同一层。
 * 车站的 class 是 railway，公交站在 poi_transit 里 class 是 bus。
 */
const RAILWAY_CLASS = ["==", ["get", "class"], "railway"] as const satisfies FilterSpecification;
const RAIL_CLASS = ["==", ["get", "class"], "rail"] as const satisfies FilterSpecification;
/** 丁目写在 place 的 neighbourhood 上，Liberty 没有单独的门牌号层。 */
const NOT_NEIGHBOURHOOD = [
  "!=",
  ["get", "class"],
  "neighbourhood",
] as const satisfies FilterSpecification;

function basemapSourceLayer(layer: { id: string }): string | undefined {
  if (!("source-layer" in layer)) return undefined;
  const sourceLayer = layer["source-layer"];
  return typeof sourceLayer === "string" ? sourceLayer : undefined;
}

/** 这个符号层是否该从底图上拿掉。 */
export function shouldHideBasemapLayer(layer: { id: string }): boolean {
  const id = layer.id;
  if (QUIET_BASEMAP_LAYER_SET.has(id)) return true;
  if (id.toLowerCase().includes("shield")) return true;
  const sourceLayer = basemapSourceLayer(layer);
  return sourceLayer === "housenumber" || id.toLowerCase().includes("housenumber");
}

function keepClass(map: Map, id: string, clause: FilterSpecification) {
  if (!map.getLayer(id)) return;
  const existing = map.getFilter(id);
  const next = (existing ? ["all", existing, clause] : clause) as FilterSpecification;
  map.setFilter(id, next);
}

/**
 * 加载完 OpenFreeMap 样式后收掉杂项，让巡礼图钉更显眼。
 * 保留城市和较大的区域名、铁路和车站、水体、公园绿地、道路线条，以及主干道名。
 * 丁目这一级从地名层拿掉。
 */
export function simplifyBasemap(map: Map) {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    if (!shouldHideBasemapLayer(layer) || !map.getLayer(layer.id)) continue;
    map.setLayoutProperty(layer.id, "visibility", "none");
  }
  for (const id of ["poi_r1", "poi_r7", "poi_r20"]) keepClass(map, id, RAILWAY_CLASS);
  keepClass(map, "poi_transit", RAIL_CLASS);
  keepClass(map, "label_other", NOT_NEIGHBOURHOOD);
}

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
