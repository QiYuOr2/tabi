import {
  setWorkerUrl,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSourceSpecification,
  type Map,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import japanArea from "../data/japan-mask.json";

/** OpenFreeMap 官方 Liberty 样式。无 key。可用 VITE_MAP_STYLE_URL 覆盖。 */
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL?.trim() || DEFAULT_MAP_STYLE_URL;

/** 平面建筑。背景是 #f8f4f0，填充只深一点，轮廓再深一档。 */
const BUILDING_FILL_COLOR = "#f1ece6";
const BUILDING_OUTLINE_COLOR = "#e6dfd6";

/** 西南、东北。可视范围限制在日本周边。 */
export const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [
  [122.5, 23.5],
  [150, 46.5],
];

export const MAP_MIN_ZOOM = 5;

/** 遮罩外环比 maxBounds 各边再外扩的度数。 */
const MASK_PAD_DEGREES = 3;

const MASK_SOURCE_ID = "outside-japan";
const MASK_LAYER_ID = "outside-japan-mask";
/** Liberty 样式里 water 填充的颜色。读不到样式时用它。 */
const SEA_COLOR = "#9ebdff";

const COUNTRY_LABEL_LAYER_IDS = new Set(["label_country_1", "label_country_2", "label_country_3"]);

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

type BasemapLayer = { id: string; type?: string; filter?: unknown };

function isAdminLevelGet(node: unknown): boolean {
  return Array.isArray(node) && node[0] === "get" && node[1] === "admin_level";
}

function someExpr(node: unknown, visit: (expr: unknown[]) => boolean): boolean {
  if (!Array.isArray(node)) return false;
  if (visit(node)) return true;
  return node.some((child) => someExpr(child, visit));
}

function selectsAdminLevel2(filter: unknown): boolean {
  return someExpr(filter, (expr) => {
    if (expr[0] !== "==") return false;
    const left = expr[1];
    const right = expr[2];
    return (
      (isAdminLevelGet(left) && (right === 2 || right === "2")) ||
      (isAdminLevelGet(right) && (left === 2 || left === "2"))
    );
  });
}

/** admin_level 大于等于 3，省、县这一级。 */
function isSubnationalBoundary(filter: unknown): boolean {
  return someExpr(filter, (expr) => {
    if (expr[0] !== ">=" && expr[0] !== ">") return false;
    if (!isAdminLevelGet(expr[1]) || typeof expr[2] !== "number") return false;
    return expr[0] === ">=" ? expr[2] >= 3 : expr[2] >= 2;
  });
}

function isCountryLabelLayer(layer: BasemapLayer): boolean {
  if (COUNTRY_LABEL_LAYER_IDS.has(layer.id)) return true;
  return layer.type === "symbol" && layer.id.toLowerCase().includes("country");
}

/** 国界整层关掉。省、县界保留。 */
function isCountryBoundaryLayer(layer: BasemapLayer): boolean {
  const id = layer.id.toLowerCase();
  if (!id.includes("boundary")) return false;
  if (id === "boundary_2" || selectsAdminLevel2(layer.filter)) return true;
  return !isSubnationalBoundary(layer.filter);
}

/** 这个符号层是否该从底图上拿掉。 */
export function shouldHideBasemapLayer(layer: BasemapLayer): boolean {
  const id = layer.id;
  if (QUIET_BASEMAP_LAYER_SET.has(id)) return true;
  if (id.toLowerCase().includes("shield")) return true;
  if (layer.type === "fill-extrusion") return true;
  if (isCountryLabelLayer(layer) || isCountryBoundaryLayer(layer)) return true;
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
 * 丁目这一级从地名层拿掉。立体建筑关掉；平面建筑若有缩放上限，就放开到高缩放。
 */
export function simplifyBasemap(map: Map) {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    if (!shouldHideBasemapLayer(layer) || !map.getLayer(layer.id)) continue;
    map.setLayoutProperty(layer.id, "visibility", "none");
  }
  for (const layer of layers) {
    if (layer.type !== "fill" || !layer.id.toLowerCase().includes("building")) continue;
    if (!map.getLayer(layer.id)) continue;
    map.setPaintProperty(layer.id, "fill-color", BUILDING_FILL_COLOR);
    if (map.getPaintProperty(layer.id, "fill-outline-color") != null) {
      map.setPaintProperty(layer.id, "fill-outline-color", BUILDING_OUTLINE_COLOR);
    }
    if (typeof layer.maxzoom !== "number") continue;
    map.setLayerZoomRange(layer.id, layer.minzoom ?? 0, 24);
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

type Ring = [number, number][];

function outsideJapanMask(): GeoJSONSourceSpecification["data"] {
  const [[west, south], [east, north]] = MAP_MAX_BOUNDS;
  const pad = MASK_PAD_DEGREES;
  const outer: Ring = [
    [west - pad, south - pad],
    [east + pad, south - pad],
    [east + pad, north + pad],
    [west - pad, north + pad],
    [west - pad, south - pad],
  ];
  // 数据里的环是逆时针，挖洞需要相反方向。
  const holes = japanArea.coordinates.map((polygon) => [...polygon[0]].reverse() as Ring);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [outer, ...holes] },
  };
}

function seaColor(map: Map): string {
  if (!map.getLayer("water")) return SEA_COLOR;
  const color = map.getPaintProperty("water", "fill-color");
  return typeof color === "string" ? color : SEA_COLOR;
}

/**
 * 日本范围以外铺一层与海面同色的不透明填充，盖住底图。
 * 图钉和浮窗是 HTML 覆盖层，仍画在它上面。几何来源见 japan-mask-source.txt。
 */
export function coverOutsideJapan(map: Map) {
  if (map.getLayer(MASK_LAYER_ID)) return;
  map.addSource(MASK_SOURCE_ID, { type: "geojson", data: outsideJapanMask() });
  map.addLayer({
    id: MASK_LAYER_ID,
    type: "fill",
    source: MASK_SOURCE_ID,
    paint: { "fill-color": seaColor(map), "fill-opacity": 1, "fill-antialias": false },
  });
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
