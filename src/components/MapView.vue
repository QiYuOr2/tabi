<script setup lang="ts">
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, Popup } from "maplibre-gl";
import {
  computed,
  createApp,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  type App,
} from "vue";
import {
  clusterByOverlap,
  previewsOverlap,
  THUMB_GAP,
  THUMB_H,
  THUMB_W,
  type ScreenPoint,
} from "../lib/cluster";
import { readMapLink, replaceMapLink } from "../lib/deep-link";
import { imagePlan, photoMedium, prefetchImage } from "../lib/images";
import {
  MAP_STYLE_URL,
  coverOutsideJapan,
  ensureMapWorker,
  preferCjkLabels,
  simplifyBasemap,
  syncMapOverview,
} from "../lib/map";
import { PhotoCreditControl } from "../lib/photo-credit-control";
import { canonicalWorkId, groupByAnime, groupByWorkId, spots, type AnimeGroup } from "../lib/spots";
import type { Spot } from "../types/spot";
import SpotCard from "./SpotCard.vue";

const container = ref<HTMLDivElement>();
const map = shallowRef<MlMap>();
const error = ref<string | null>(null);
const hidden = ref(new Set<string>());
/** 小于 Tailwind sm（640px）算窄屏。把手在面板高度上垂直居中，收起后仍停在这个高度。 */
const LEGEND_NARROW_QUERY = "(max-width: 639px)";
const narrow = ref(window.matchMedia(LEGEND_NARROW_QUERY).matches);
const legendCollapsed = ref(true);
let legendMedia: MediaQueryList | undefined;

function onLegendMedia() {
  narrow.value = legendMedia?.matches ?? false;
}

function toggleLegend() {
  legendCollapsed.value = !legendCollapsed.value;
  if (locateToast.value) void nextTick(() => placeLocateToast());
}

/** 图例收起动画时长。定位后等它滑走再量一次提示，避免按展开时的占位摆。 */
const LEGEND_COLLAPSE_MS = 200;
let legendPlaceTimer = 0;

/** 窄屏定位时收起图例。桌面不收。已经收起时不再重播动画。 */
function collapseLegendForLocate() {
  if (!narrow.value || legendCollapsed.value) return;
  legendCollapsed.value = true;
  window.clearTimeout(legendPlaceTimer);
  legendPlaceTimer = window.setTimeout(() => {
    legendPlaceTimer = 0;
    if (locateToast.value) placeLocateToast();
  }, LEGEND_COLLAPSE_MS + 20);
}

const groups = groupByAnime(spots);
const colorOf = (s: Spot) => groups.find((g) => g.spots.includes(s))?.color ?? "#555";

/** 没有 anitabi 地标的实拍，小于这个经纬跨度才算同一地点。大约十几米。 */
const SAME_SPOT = 0.00008;
/** 放到这一级仍叠在一起，不同场景就在画面上散开，不再合成一个图钉。 */
const CLUSTER_MAX_ZOOM = 17;

interface Pin {
  group: string;
  spot: Spot;
  button: HTMLButtonElement;
  badge: HTMLSpanElement;
  marker: Marker;
  /** 相对真实坐标的屏幕偏移。散开时非 0，地理坐标不变。 */
  offset: { x: number; y: number };
  /** 缩略图进入画面后才赋值 src。 */
  loadThumb: () => void;
}

const pins: Pin[] = [];
let membersOf = new Map<string, Pin[]>();
let popup: Popup | null = null;
let popupApp: App | null = null;
let selectedId: string | null = null;
let layoutQueued = false;
/** 打开 ?spot= 的飞行还没结束时递增，用来丢掉过期的打开。 */
let spotReveal = 0;
/** 还没打开浮窗的 ?spot=。用户把地图拖走时清掉地址栏。 */
let pendingSpot: string | null = null;

function setLink(next: { work: string | null; spot: string | null }) {
  replaceMapLink(next);
}

function cancelSpotReveal() {
  spotReveal += 1;
  if (!pendingSpot) return;
  pendingSpot = null;
  setLink({ work: null, spot: null });
}

function closePopup(opts?: { preserveLink?: boolean }) {
  selectedId = null;
  const app = popupApp;
  const current = popup;
  popupApp = null;
  popup = null;
  app?.unmount();
  current?.remove();
  if (!opts?.preserveLink) setLink({ work: null, spot: null });
}

function popupMaxWidth(m: MlMap) {
  const width = m.getContainer().clientWidth;
  return `${Math.max(160, Math.min(300, width - 24))}px`;
}

/** 弹层超出地图或盖住图例/缩放按钮时，平移地图把它挪进可视区域。 */
function panPopupIntoView(m: MlMap, p: Popup) {
  const el = p.getElement();
  if (!el) return;
  const mapRect = m.getContainer().getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const margin = 8;
  let minLeft = mapRect.left + margin;
  let minTop = mapRect.top + margin;
  let maxRight = mapRect.right - margin;
  let maxBottom = mapRect.bottom - margin;

  const legendRoot = document.querySelector("[data-map-legend]");
  const legend = (
    legendRoot?.classList.contains("is-collapsed")
      ? legendRoot.querySelector("[data-legend-handle]")
      : legendRoot
  )?.getBoundingClientRect();
  if (
    legend &&
    legend.width > 0 &&
    rect.left < legend.right + margin &&
    rect.top < legend.bottom + margin
  ) {
    minTop = Math.max(minTop, legend.bottom + margin);
  }
  const rightControls = m.getContainer().querySelector(".maplibregl-ctrl-bottom-right");
  const right = rightControls?.getBoundingClientRect();
  if (
    right &&
    right.width > 0 &&
    rect.right > right.left - margin &&
    rect.bottom > right.top - margin
  ) {
    maxBottom = Math.min(maxBottom, right.top - margin);
    maxRight = Math.min(maxRight, right.left - margin);
  }
  const leftControls = m.getContainer().querySelector(".maplibregl-ctrl-bottom-left");
  const left = leftControls?.getBoundingClientRect();
  if (
    left &&
    left.width > 0 &&
    rect.left < left.right + margin &&
    rect.bottom > left.top - margin
  ) {
    maxBottom = Math.min(maxBottom, left.top - margin);
    minLeft = Math.max(minLeft, left.right + margin);
  }

  let x = 0;
  let y = 0;
  if (rect.left < minLeft) x = rect.left - minLeft;
  else if (rect.right > maxRight) x = rect.right - maxRight;
  if (rect.top < minTop) y = rect.top - minTop;
  else if (rect.bottom > maxBottom) y = rect.bottom - maxBottom;
  if (x !== 0 || y !== 0) {
    m.panBy([x, y], { duration: 200 });
    return true;
  }
  return false;
}

function schedulePan(m: MlMap, p: Popup) {
  // 弹层可能晚一帧才摆到锚点上。平移结束后再量一次，把剩下的溢出补掉。
  let tries = 0;
  const run = () => {
    if (popup !== p || tries >= 4) return;
    tries += 1;
    if (!panPopupIntoView(m, p)) return;
    m.once("moveend", () => {
      requestAnimationFrame(run);
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function bySpotId(a: Pin, b: Pin) {
  return a.spot.id < b.spot.id ? -1 : 1;
}

/**
 * 同一个动画场景分成一组。
 * 有 anitabiPointId 的只和相同 pointId 合并；没有的按 SAME_SPOT 互相合并。
 * 有 pointId 的不和没有的并在一起。
 */
function sceneGroups(list: Pin[]): Pin[][] {
  const byPoint = new Map<string, Pin[]>();
  const bare: Pin[] = [];
  for (const pin of list) {
    const pointId = pin.spot.anitabiPointId;
    if (pointId) {
      const key = `${pin.spot.bangumiId ?? ""}:${pointId}`;
      const bucket = byPoint.get(key);
      if (bucket) bucket.push(pin);
      else byPoint.set(key, [pin]);
    } else bare.push(pin);
  }
  const groups = [...byPoint.values()];
  if (bare.length > 0) {
    const parent = bare.map((_, i) => i);
    const find = (i: number): number => {
      let p = i;
      while (parent[p] !== p) p = parent[p]!;
      return p;
    };
    const near = (a: Spot, b: Spot) =>
      Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng)) < SAME_SPOT;
    for (let i = 0; i < bare.length; i++) {
      for (let j = i + 1; j < bare.length; j++) {
        if (!near(bare[i]!.spot, bare[j]!.spot)) continue;
        const pa = find(i);
        const pb = find(j);
        if (pa !== pb) parent[pa] = pb;
      }
    }
    const buckets = new Map<number, Pin[]>();
    for (let i = 0; i < bare.length; i++) {
      const root = find(i);
      const bucket = buckets.get(root);
      if (bucket) bucket.push(bare[i]!);
      else buckets.set(root, [bare[i]!]);
    }
    groups.push(...buckets.values());
  }
  for (const group of groups) group.sort(bySpotId);
  groups.sort((a, b) => bySpotId(a[0]!, b[0]!));
  return groups;
}

function scenePages(spot: Spot): Spot[] {
  const visible = pins.filter((pin) => !hidden.value.has(pin.group));
  const found = sceneGroups(visible).find((group) => group.some((pin) => pin.spot.id === spot.id));
  const pages = (found ?? []).map((pin) => pin.spot);
  if (!pages.some((page) => page.id === spot.id)) return [spot];
  return pages;
}

const badgeWidths = new Map<number, number>();
let badgeMeasure: CanvasRenderingContext2D | null | undefined;

/** 角标是 12px 字、左右各 4px 内边距，最短 18px。和 .spot-thumb-count 一致。 */
function badgeWidth(count: number) {
  const cached = badgeWidths.get(count);
  if (cached != null) return cached;
  badgeMeasure ??= document.createElement("canvas").getContext("2d");
  let width = 18;
  if (badgeMeasure) {
    const family = getComputedStyle(document.body).fontFamily;
    badgeMeasure.font = `12px ${family}`;
    width = Math.max(18, Math.ceil(badgeMeasure.measureText(String(count)).width) + 8);
  }
  badgeWidths.set(count, width);
  return width;
}

function cardOnScreen(x: number, y: number, width: number, height: number) {
  const left = x - THUMB_W / 2;
  const right = x + THUMB_W / 2;
  const top = y - THUMB_H / 2;
  const bottom = y + THUMB_H / 2;
  return right > 0 && left < width && bottom > 0 && top < height;
}

/**
 * 同一坐标散开的偏移。相邻锚点默认至少隔开一个图钉加缝（THUMB_W + THUMB_GAP + 12）。
 * 锚点四舍五入后，斜向的外框角有时仍会叠住，这时才把半径加大。没叠住时偏移和原来一致。
 */
function ringShifts(cx: number, cy: number, anchors: { x: number; y: number }[], counts: number[]) {
  const count = anchors.length;
  if (count <= 1) return [{ x: 0, y: 0 }];
  const layout = (radius: number) => {
    const shifts: { x: number; y: number }[] = [];
    const centers: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      const shift = {
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
      };
      const anchor = anchors[i]!;
      const ox = Math.round(cx + shift.x - anchor.x);
      const oy = Math.round(cy + shift.y - anchor.y);
      shifts.push(shift);
      centers.push({ x: anchor.x + ox, y: anchor.y - THUMB_H / 2 + oy });
    }
    return { shifts, centers };
  };
  const overlaps = (centers: { x: number; y: number }[]) => {
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (previewsOverlap(centers[i]!, counts[i]!, centers[j]!, counts[j]!, badgeWidth))
          return true;
      }
    }
    return false;
  };
  const minDist = THUMB_W + THUMB_GAP + 12;
  let radius = count === 2 ? minDist / 2 : minDist / (2 * Math.sin(Math.PI / count));
  let placed = layout(radius);
  for (let step = 0; step < 24 && overlaps(placed.centers); step++) {
    radius += 2;
    placed = layout(radius);
  }
  return placed.shifts;
}

function placePin(pin: Pin, x: number, y: number) {
  if (pin.offset.x === x && pin.offset.y === y) return;
  pin.offset = { x, y };
  pin.marker.setOffset([x, y]);
}

/** 已经画出来的预览中心。偏移加在底边锚点上，中心在锚点上方半个图钉。 */
function previewCenter(m: MlMap, pin: Pin) {
  const p = m.project([pin.spot.lng, pin.spot.lat]);
  return { x: p.x + pin.offset.x, y: p.y - THUMB_H / 2 + pin.offset.y };
}

/**
 * 同一坐标散开后，圆环若盖住旁边已经分开的图钉，就把那枚也拉上同一个圆环再排一次。
 * 没盖住任何人时不重算，偏移和原来的圆环一致。
 * 已经被别的圆环拉走的图钉留在那边，避免两枚圆环来回抢。
 */
function settleFans(
  m: MlMap,
  fans: { reps: Pin[]; cx: number; cy: number }[],
  members: Map<string, Pin[]>,
) {
  const parked = new Set<Pin>();
  const countOf = (pin: Pin) => members.get(pin.spot.id)?.length ?? 1;

  for (const fan of fans) {
    if (fan.reps.some((pin) => parked.has(pin))) continue;
    const reps = [...fan.reps];
    const inRing = new Set(reps);
    let guard = pins.length;
    while (guard > 0) {
      guard -= 1;
      const anchors = reps.map((rep) => {
        const anchor = m.project([rep.spot.lng, rep.spot.lat]);
        return { x: anchor.x, y: anchor.y };
      });
      const offsets = ringShifts(
        fan.cx,
        fan.cy,
        anchors,
        reps.map((pin) => countOf(pin)),
      );
      let extra: Pin | undefined;
      for (const pin of pins) {
        if (inRing.has(pin) || parked.has(pin) || pin.button.classList.contains("is-hidden"))
          continue;
        const center = previewCenter(m, pin);
        const count = countOf(pin);
        const hit = reps.some((rep, index) => {
          const shift = offsets[index] ?? { x: 0, y: 0 };
          const anchor = anchors[index]!;
          const ox = Math.round(fan.cx + shift.x - anchor.x);
          const oy = Math.round(fan.cy + shift.y - anchor.y);
          return previewsOverlap(
            { x: anchor.x + ox, y: anchor.y - THUMB_H / 2 + oy },
            countOf(rep),
            center,
            count,
            badgeWidth,
          );
        });
        if (hit) {
          extra = pin;
          break;
        }
      }
      if (!extra) break;
      reps.push(extra);
      inRing.add(extra);
    }
    if (reps.length === fan.reps.length) continue;
    const anchors = reps.map((rep) => {
      const anchor = m.project([rep.spot.lng, rep.spot.lat]);
      return { x: anchor.x, y: anchor.y };
    });
    const offsets = ringShifts(
      fan.cx,
      fan.cy,
      anchors,
      reps.map((pin) => countOf(pin)),
    );
    for (let index = 0; index < reps.length; index++) {
      const rep = reps[index]!;
      const anchor = anchors[index]!;
      const shift = offsets[index] ?? { x: 0, y: 0 };
      placePin(
        rep,
        Math.round(fan.cx + shift.x - anchor.x),
        Math.round(fan.cy + shift.y - anchor.y),
      );
      setShown(rep, true);
      parked.add(rep);
    }
  }
}

/** 浮窗锚在正在显示的那枚图钉上。同一场景里点到的那张若被收进角标，仍用代表图钉的偏移。 */
function popupAnchor(spot: Spot) {
  const pin = pins.find((item) => item.spot.id === spot.id);
  if (!pin || !pin.button.classList.contains("is-hidden")) {
    return { lng: spot.lng, lat: spot.lat, offset: pin?.offset ?? { x: 0, y: 0 } };
  }
  const shown = (membersOf.get(pin.spot.id) ?? []).find(
    (item) => !item.button.classList.contains("is-hidden"),
  );
  if (!shown) return { lng: spot.lng, lat: spot.lat, offset: pin.offset };
  return { lng: shown.spot.lng, lat: shown.spot.lat, offset: shown.offset };
}

function openPopup(m: MlMap, spot: Spot) {
  closePopup({ preserveLink: true });
  const pages = scenePages(spot);
  const start = Math.max(
    0,
    pages.findIndex((page) => page.id === spot.id),
  );
  selectedId = spot.id;
  warmPopup(pages, start);
  const host = document.createElement("div");
  // 先定宽，避免图片固有尺寸把弹层撑开后，平移按旧宽度算偏。
  host.style.width = popupMaxWidth(m);
  popupApp = createApp(SpotCard, {
    spots: pages,
    start,
    colors: pages.map((page) => colorOf(page)),
    onClose: () => closePopup(),
    onSelect: (page: Spot) => setLink({ work: null, spot: page.id }),
  });
  popupApp.mount(host);

  const anchor = popupAnchor(spot);
  const next = new Popup({
    closeButton: false,
    closeOnClick: false,
    anchor: "bottom",
    offset: [anchor.offset.x, anchor.offset.y - (THUMB_H + 8)],
    maxWidth: popupMaxWidth(m),
    className: "spot-popup",
    focusAfterOpen: false,
  })
    .setLngLat([anchor.lng, anchor.lat])
    .setDOMContent(host)
    .addTo(m);
  popup = next;
  next.on("close", () => {
    if (popup !== next) return;
    popupApp?.unmount();
    popupApp = null;
    popup = null;
    selectedId = null;
    setLink({ work: null, spot: null });
  });
  setLink({ work: null, spot: spot.id });
  schedulePan(m, next);
}

function spreadOf(list: Pin[]) {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const pin of list) {
    minLng = Math.min(minLng, pin.spot.lng);
    maxLng = Math.max(maxLng, pin.spot.lng);
    minLat = Math.min(minLat, pin.spot.lat);
    maxLat = Math.max(maxLat, pin.spot.lat);
  }
  return Math.max(maxLng - minLng, maxLat - minLat);
}

function setShown(pin: Pin, shown: boolean) {
  pin.button.classList.toggle("is-hidden", !shown);
  pin.button.tabIndex = shown ? 0 : -1;
  if (shown) {
    pin.button.removeAttribute("aria-hidden");
    pin.loadThumb();
  } else pin.button.setAttribute("aria-hidden", "true");
}

function layoutPins() {
  const m = map.value;
  if (!m) return;
  const width = m.getContainer().clientWidth;
  const height = m.getContainer().clientHeight;
  const hiddenSet = hidden.value;
  const projected: ScreenPoint<Pin>[] = [];

  for (const pin of pins) {
    if (hiddenSet.has(pin.group)) {
      setShown(pin, false);
      continue;
    }
    let p;
    try {
      p = m.project([pin.spot.lng, pin.spot.lat]);
    } catch {
      return;
    }
    // 锚点在缩略图底边中点，碰撞用画面中心。
    projected.push({ item: pin, x: p.x, y: p.y - THUMB_H / 2 });
  }

  projected.sort((a, b) => bySpotId(a.item, b.item));
  const clusters = clusterByOverlap(projected, badgeWidth, (point) =>
    cardOnScreen(point.x, point.y, width, height),
  );
  const nextMembers = new Map<string, Pin[]>();
  const fans: { reps: Pin[]; cx: number; cy: number }[] = [];

  for (const cluster of clusters) {
    const items = cluster.map((point) => point.item);
    for (const pin of items) nextMembers.set(pin.spot.id, items);

    const onScreen = cluster.filter((point) => cardOnScreen(point.x, point.y, width, height));
    if (onScreen.length === 0) {
      for (const pin of items) setShown(pin, false);
      continue;
    }

    onScreen.sort((a, b) => bySpotId(a.item, b.item));
    const scenes = sceneGroups(items);
    const present = scenes.filter((scene) =>
      scene.some((pin) => onScreen.some((point) => point.item === pin)),
    );
    const fan = present.length > 1 && m.getZoom() >= CLUSTER_MAX_ZOOM - 1e-6;
    if (!fan) {
      // 代表是占位时的那一枚。它在画面上时就画在它自己的坐标，数量才和碰撞范围对得上。
      const rep = (onScreen.find((point) => point === cluster[0]) ?? onScreen[0])!.item;
      for (const pin of items) {
        setShown(pin, pin === rep);
        placePin(pin, 0, 0);
      }
      const count = items.length;
      const oneScene = scenes.length <= 1;
      if (count > 1) {
        rep.badge.hidden = false;
        rep.badge.textContent = String(count);
        const label = oneScene
          ? `${rep.spot.animeName} · ${count} 张照片`
          : `${rep.spot.animeName} · ${count} 个地点`;
        rep.button.title = label;
        rep.button.setAttribute("aria-label", `${label}，${oneScene ? "点击查看" : "点击放大"}`);
      } else {
        rep.badge.hidden = true;
        rep.badge.textContent = "";
        const label = `${rep.spot.animeName} · ${rep.spot.pointName}`;
        rep.button.title = label;
        rep.button.setAttribute("aria-label", label);
      }
      continue;
    }

    // 不同场景叠在同一像素上时，绕真实坐标散开，每组一个可点的图钉。
    let cx = 0;
    let cy = 0;
    for (const point of onScreen) {
      cx += point.x;
      cy += point.y + THUMB_H / 2;
    }
    cx /= onScreen.length;
    cy /= onScreen.length;
    const shown = new Set<Pin>();
    const reps: Pin[] = [];
    const fanAnchors: { x: number; y: number }[] = [];
    for (const scene of present) {
      const rep = scene.find((pin) => onScreen.some((point) => point.item === pin))!;
      const at = onScreen.find((point) => point.item === rep)!;
      reps.push(rep);
      fanAnchors.push({ x: at.x, y: at.y + THUMB_H / 2 });
    }
    const offsets = ringShifts(
      cx,
      cy,
      fanAnchors,
      present.map((scene) => scene.length),
    );
    present.forEach((scene, index) => {
      const rep = reps[index]!;
      shown.add(rep);
      const anchor = fanAnchors[index]!;
      const shift = offsets[index] ?? { x: 0, y: 0 };
      placePin(rep, Math.round(cx + shift.x - anchor.x), Math.round(cy + shift.y - anchor.y));
      for (const pin of scene) {
        if (pin !== rep) placePin(pin, 0, 0);
        nextMembers.set(pin.spot.id, scene);
      }
      const count = scene.length;
      if (count > 1) {
        rep.badge.hidden = false;
        rep.badge.textContent = String(count);
        const label = `${rep.spot.animeName} · ${count} 张照片`;
        rep.button.title = label;
        rep.button.setAttribute("aria-label", `${label}，点击查看`);
      } else {
        rep.badge.hidden = true;
        rep.badge.textContent = "";
        const label = `${rep.spot.animeName} · ${rep.spot.pointName}`;
        rep.button.title = label;
        rep.button.setAttribute("aria-label", label);
      }
    });
    for (const pin of items) setShown(pin, shown.has(pin));
    fans.push({ reps, cx, cy });
  }

  settleFans(m, fans, nextMembers);
  membersOf = nextMembers;
  applyLocateHighlight();
}

function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutPins();
  });
}

function onThumbClick(m: MlMap, pin: Pin) {
  cancelSpotReveal();
  cancelLocateHighlight();
  const members = membersOf.get(pin.spot.id) ?? [pin];
  const scenes = sceneGroups(members);
  if (scenes.length <= 1) {
    openPopup(m, pin.spot);
    return;
  }
  closePopup();
  // 不同场景靠得太近，放大到顶后由 layout 把图钉散开，而不是合成一个浮窗。
  if (spreadOf(members) < SAME_SPOT) {
    if (m.getZoom() < CLUSTER_MAX_ZOOM) {
      m.easeTo({ center: [pin.spot.lng, pin.spot.lat], zoom: CLUSTER_MAX_ZOOM, duration: 400 });
    }
    return;
  }
  const bounds = new LngLatBounds();
  for (const member of members) bounds.extend([member.spot.lng, member.spot.lat]);
  const view = Math.min(m.getContainer().clientWidth, m.getContainer().clientHeight);
  const padding = Math.max(48, Math.min(100, Math.round(view * 0.2)));
  m.fitBounds(bounds, { padding, maxZoom: CLUSTER_MAX_ZOOM, duration: 400 });
}

/** 预取当前页和前后各一页：动画截图 h360，实拍用 640 中图。不拉 1280 原图。 */
function warmPopup(pages: Spot[], index: number) {
  for (let i = index - 1; i <= index + 1; i++) {
    const page = pages[i];
    if (!page) continue;
    prefetchImage(imagePlan(page.animeImage, "h360"));
    prefetchImage(photoMedium(page.photo));
  }
}

function createThumb(spot: Spot) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "spot-thumb is-hidden";
  button.tabIndex = -1;
  button.setAttribute("aria-hidden", "true");
  const label = `${spot.animeName} · ${spot.pointName}`;
  button.title = label;
  button.setAttribute("aria-label", label);

  const frame = document.createElement("span");
  frame.className = "spot-thumb-frame";
  const skel = document.createElement("span");
  skel.className = "spot-thumb-skel";
  skel.setAttribute("aria-hidden", "true");

  const primary = spot.photoThumb || null;
  const fallback = spot.photo;
  const src = primary || fallback;
  let loadThumb = () => {};
  if (src) {
    const img = document.createElement("img");
    img.className = "spot-thumb-img";
    img.alt = "";
    img.draggable = false;
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    let usingFallback = !primary || primary === fallback;
    const ready = () => {
      img.classList.add("is-ready");
      skel.remove();
    };
    img.addEventListener("load", ready);
    img.addEventListener("error", () => {
      if (!usingFallback && fallback && fallback !== primary) {
        usingFallback = true;
        img.src = fallback;
        if (img.complete && img.naturalWidth > 0) ready();
        return;
      }
      skel.classList.add("is-error");
      skel.textContent = "无";
    });
    frame.append(img, skel);
    loadThumb = () => {
      if (img.getAttribute("src")) return;
      img.src = src;
      if (img.complete && img.naturalWidth > 0) ready();
    };
  } else {
    skel.classList.add("is-error");
    skel.textContent = "无";
    frame.append(skel);
  }

  const badge = document.createElement("span");
  badge.className = "spot-thumb-count";
  badge.hidden = true;
  // MapLibre 把定位写在按钮的 transform 上。整颗图钉的缩放放在内层，原点在底边中点，地点不会漂。
  const body = document.createElement("span");
  body.className = "spot-thumb-pin";
  body.append(frame, badge);
  button.append(body);
  return { button, badge, loadThumb };
}

function pinBody(pin: Pin) {
  return pin.button.querySelector(".spot-thumb-pin");
}

function applyHidden(next: Set<string>) {
  cancelSpotReveal();
  hidden.value = next;
  const selected = pins.find((item) => item.spot.id === selectedId);
  if (selected && next.has(selected.group)) closePopup();
  scheduleLayout();
}

function toggleGroup(key: string) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  applyHidden(next);
}

const shownGroupCount = computed(() => groups.filter((g) => !hidden.value.has(g.key)).length);
const allShown = computed(() => shownGroupCount.value === groups.length);
const noneShown = computed(() => shownGroupCount.value === 0);
const allEyeLabel = computed(() => (allShown.value ? "隐藏全部" : "显示全部"));

function toggleAllGroups() {
  applyHidden(allShown.value ? new Set(groups.map((g) => g.key)) : new Set());
}

/** 图例眼睛的「仅显示此项」。右键或触屏长按打开，点空白、Esc、滚动关掉。 */
const EYE_LONG_PRESS_MS = 500;
const eyeMenu = ref<{ key: string; x: number; y: number } | null>(null);
const eyeMenuEl = ref<HTMLElement>();
const eyeMenuItem = ref<HTMLButtonElement>();
let eyePressTimer = 0;
let eyePressX = 0;
let eyePressY = 0;
let eyeMenuOpenedAt = 0;
let ignoreEyeClickUntil = 0;
let ignoreMenuClickUntil = 0;

function closeEyeMenu() {
  eyeMenu.value = null;
}

function openEyeMenu(point: { clientX: number; clientY: number }, key: string) {
  const root = container.value?.parentElement;
  if (!root) return;
  const rect = root.getBoundingClientRect();
  eyeMenuOpenedAt = performance.now();
  eyeMenu.value = { key, x: point.clientX - rect.left, y: point.clientY - rect.top };
  void nextTick(() => {
    const rootNow = container.value?.parentElement;
    const el = eyeMenuEl.value;
    const menu = eyeMenu.value;
    if (!rootNow || !el || !menu) return;
    const bounds = rootNow.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const margin = 8;
    let x = menu.x;
    let y = menu.y - box.height - margin;
    if (y < margin) y = menu.y + margin;
    if (x + box.width > bounds.width - margin) x = bounds.width - margin - box.width;
    if (y + box.height > bounds.height - margin) y = bounds.height - margin - box.height;
    eyeMenu.value = { key: menu.key, x: Math.max(margin, x), y: Math.max(margin, y) };
    void nextTick(() => eyeMenuItem.value?.focus({ preventScroll: true }));
  });
}

function showOnlyGroup(key: string) {
  if (performance.now() < ignoreMenuClickUntil) return;
  const next = new Set<string>();
  for (const group of groups) if (group.key !== key) next.add(group.key);
  closeEyeMenu();
  applyHidden(next);
}

function onEyeClick(key: string) {
  if (performance.now() < ignoreEyeClickUntil) return;
  toggleGroup(key);
}

function onEyeContextMenu(ev: MouseEvent, key: string) {
  ev.preventDefault();
  if (eyeMenu.value?.key === key && performance.now() - eyeMenuOpenedAt < 400) return;
  openEyeMenu(ev, key);
}

function onEyePointerDown(ev: PointerEvent, key: string) {
  if (ev.pointerType === "mouse") return;
  window.clearTimeout(eyePressTimer);
  eyePressX = ev.clientX;
  eyePressY = ev.clientY;
  eyePressTimer = window.setTimeout(() => {
    eyePressTimer = 0;
    const now = performance.now();
    ignoreEyeClickUntil = now + 800;
    ignoreMenuClickUntil = now + 400;
    openEyeMenu({ clientX: eyePressX, clientY: eyePressY }, key);
  }, EYE_LONG_PRESS_MS);
}

function onEyePointerMove(ev: PointerEvent) {
  if (!eyePressTimer) return;
  if (Math.hypot(ev.clientX - eyePressX, ev.clientY - eyePressY) <= 10) return;
  window.clearTimeout(eyePressTimer);
  eyePressTimer = 0;
}

function onEyePointerEnd() {
  window.clearTimeout(eyePressTimer);
  eyePressTimer = 0;
}

function onDocPointerDown(ev: PointerEvent) {
  if (!eyeMenu.value) return;
  const menu = eyeMenuEl.value;
  if (menu && ev.target instanceof Node && menu.contains(ev.target)) return;
  closeEyeMenu();
}

function onDocKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && eyeMenu.value) closeEyeMenu();
}

function onAnyScroll() {
  if (eyeMenu.value) closeEyeMenu();
}

/** 定位后短时间压暗其他作品，并提示地点数。点图钉或用户拖动/缩放会取消高亮。 */
const LOCATE_HIGHLIGHT_MS = 1800;
const LOCATE_TOAST_MS = 2000;
let locateKey: string | null = null;
let locateToken = 0;
let locateTimer = 0;
let toastTimer = 0;
const locateToast = ref<string | null>(null);
const locateToastKey = ref(0);
const locateToastPlaced = ref(false);
const locateToastStyle = ref({ top: "10px", left: "50%", transform: "translateX(-50%)" });
const locateToastEl = ref<HTMLElement>();

function dismissToast() {
  window.clearTimeout(toastTimer);
  toastTimer = 0;
  locateToast.value = null;
}

function rectsOverlap(a: DOMRect, b: DOMRect, margin: number) {
  return (
    a.left < b.right + margin &&
    a.right > b.left - margin &&
    a.top < b.bottom + margin &&
    a.bottom > b.top - margin
  );
}

function placeLocateToast() {
  const root = container.value?.parentElement;
  const el = locateToastEl.value;
  if (!root || !el) return;
  const mapRect = root.getBoundingClientRect();
  const margin = 10;
  const measure = (top: number, left: number) => {
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.transform = "translateX(-50%)";
    return el.getBoundingClientRect();
  };
  let top = margin;
  let left = mapRect.width / 2;
  let rect = measure(top, left);

  const legendRoot = root.querySelector("[data-map-legend]");
  const legendTarget = legendRoot?.classList.contains("is-collapsed")
    ? legendRoot.querySelector("[data-legend-handle]")
    : legendRoot;
  const legend =
    legendTarget instanceof HTMLElement ? legendTarget.getBoundingClientRect() : undefined;
  if (legend && legend.width > 0 && rectsOverlap(rect, legend, 8)) {
    const below = legend.bottom - mapRect.top + margin;
    if (below + rect.height <= mapRect.height - margin) {
      top = below;
      rect = measure(top, left);
    }
    if (rectsOverlap(rect, legend, 8)) {
      const beside = legend.right - mapRect.left + margin + rect.width / 2;
      if (beside + rect.width / 2 <= mapRect.width - margin) {
        top = margin;
        left = beside;
        rect = measure(top, left);
      }
    }
  }

  const blocks = [
    map.value?.getContainer().querySelector(".maplibregl-ctrl-bottom-left"),
    map.value?.getContainer().querySelector(".maplibregl-ctrl-bottom-right"),
  ];
  for (const node of blocks) {
    if (!(node instanceof HTMLElement)) continue;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || !rectsOverlap(rect, box, 8)) continue;
    const shifted = box.top - mapRect.top - margin - rect.height;
    if (shifted < margin) continue;
    top = shifted;
    rect = measure(top, left);
  }

  const half = rect.width / 2;
  const minLeft = margin + half;
  const maxLeft = Math.max(minLeft, mapRect.width - margin - half);
  left = Math.min(Math.max(left, minLeft), maxLeft);
  measure(top, left);
  locateToastStyle.value = { top: `${top}px`, left: `${left}px`, transform: "translateX(-50%)" };
  locateToastPlaced.value = true;
}

function showLocateToast(text: string) {
  locateToastKey.value += 1;
  locateToastPlaced.value = false;
  locateToast.value = text;
  locateToastStyle.value = { top: "10px", left: "50%", transform: "translateX(-50%)" };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = 0;
    locateToast.value = null;
  }, LOCATE_TOAST_MS);
  // 图例正在滑出时先不摆，等收起后再量，避免提示跟着半开的面板跳一截。
  if (legendPlaceTimer) return;
  void nextTick(() => placeLocateToast());
}

function applyLocateHighlight() {
  if (!locateKey) return;
  const token = String(locateToken);
  for (const pin of pins) {
    const body = pinBody(pin);
    if (pin.button.classList.contains("is-hidden")) {
      pin.button.classList.remove("is-dim", "is-focus");
      delete pin.button.dataset.focusToken;
      body?.classList.remove("is-pulse");
      continue;
    }
    const members = membersOf.get(pin.spot.id) ?? [pin];
    const focused = members.some((item) => item.group === locateKey);
    pin.button.classList.toggle("is-dim", !focused);
    pin.button.classList.toggle("is-focus", focused);
    if (!focused || !(body instanceof HTMLElement)) {
      delete pin.button.dataset.focusToken;
      body?.classList.remove("is-pulse");
      continue;
    }
    if (pin.button.dataset.focusToken === token) continue;
    pin.button.dataset.focusToken = token;
    body.classList.remove("is-pulse");
    void body.offsetWidth;
    body.classList.add("is-pulse");
  }
}

function cancelLocateHighlight() {
  window.clearTimeout(locateTimer);
  locateTimer = 0;
  locateKey = null;
  for (const pin of pins) {
    pin.button.classList.remove("is-dim", "is-focus");
    delete pin.button.dataset.focusToken;
    pinBody(pin)?.classList.remove("is-pulse");
  }
}

/** flyTo/fitBounds 会同步触发 movestart，但这次 MapLibre 不带 originalEvent。只放行这一下。 */
let suppressLocateCancel = false;

function moveCamera(run: () => void) {
  suppressLocateCancel = true;
  try {
    run();
  } finally {
    suppressLocateCancel = false;
  }
}

function onUserCamera() {
  // flyTo/fitBounds 的 movestart 是同步的，而且落在 moveCamera 里。那一下不算用户把链接拖丢。
  if (!suppressLocateCancel) cancelSpotReveal();
  if (suppressLocateCancel || !locateKey) return;
  cancelLocateHighlight();
}

function startLocateHighlight(group: AnimeGroup) {
  locateToken += 1;
  locateKey = group.key;
  window.clearTimeout(locateTimer);
  for (const pin of pins) {
    delete pin.button.dataset.focusToken;
    pinBody(pin)?.classList.remove("is-pulse");
  }
  locateTimer = window.setTimeout(() => cancelLocateHighlight(), LOCATE_HIGHLIGHT_MS);
  showLocateToast(`「${group.animeName} · ${group.spots.length} 个地点」`);
  scheduleLayout();
}

/** 与页面初次加载相同：先按视口套上日本全图的最小缩放，再拟合全部地点。 */
function fitInitialView(m: MlMap, duration: number) {
  syncMapOverview(m);
  const bounds = new LngLatBounds();
  for (const group of groups) {
    for (const spot of group.spots) bounds.extend([spot.lng, spot.lat]);
  }
  if (bounds.isEmpty()) return;
  moveCamera(() => {
    m.fitBounds(bounds, { padding: 64, maxZoom: 14, duration });
  });
}

function resetView() {
  const m = map.value;
  if (!m) return;
  cancelSpotReveal();
  cancelLocateHighlight();
  dismissToast();
  closePopup();
  fitInitialView(m, 400);
}

/** 只有一个地点时飞到这一级，多地点的包围盒也不会放得比这更近。 */
const FOCUS_ZOOM = 16;

/**
 * 桌面图例停在左上角，包围盒上边多 40、左边多 24，躲开面板。
 * 窄屏定位会先收起图例，四边用同一边距，不再为已经关上的面板留空。
 */
function locateFitPadding(m: MlMap) {
  const view = Math.min(m.getContainer().clientWidth, m.getContainer().clientHeight);
  const padding = Math.max(48, Math.min(80, Math.round(view * 0.12)));
  if (narrow.value) return padding;
  return { top: padding + 40, right: padding, bottom: padding, left: padding + 24 };
}

function focusGroup(key: string) {
  const m = map.value;
  const group = groups.find((item) => item.key === key);
  if (!m || !group || group.spots.length === 0) return;
  cancelSpotReveal();
  if (hidden.value.has(key)) {
    const next = new Set(hidden.value);
    next.delete(key);
    hidden.value = next;
  }
  collapseLegendForLocate();
  closePopup({ preserveLink: true });
  startLocateHighlight(group);
  setLink({ work: canonicalWorkId(group), spot: null });
  if (group.spots.length === 1) {
    const spot = group.spots[0]!;
    moveCamera(() => {
      m.flyTo({ center: [spot.lng, spot.lat], zoom: FOCUS_ZOOM, duration: 400 });
    });
    return;
  }
  const bounds = new LngLatBounds();
  for (const spot of group.spots) bounds.extend([spot.lng, spot.lat]);
  moveCamera(() => {
    m.fitBounds(bounds, {
      padding: locateFitPadding(m),
      maxZoom: FOCUS_ZOOM,
      duration: 400,
    });
  });
}

/** 飞到这一级后，不同场景会散开成单独的图钉，不再停在聚合里。 */
function revealSpot(m: MlMap, spot: Spot) {
  const token = ++spotReveal;
  pendingSpot = spot.id;
  const group = groups.find((item) => item.spots.some((page) => page.id === spot.id));
  if (group && hidden.value.has(group.key)) {
    const next = new Set(hidden.value);
    next.delete(group.key);
    hidden.value = next;
  }
  cancelLocateHighlight();
  dismissToast();
  moveCamera(() => {
    m.flyTo({ center: [spot.lng, spot.lat], zoom: CLUSTER_MAX_ZOOM, duration: 400 });
  });
  const open = () => {
    if (token !== spotReveal) return;
    if (!m.loaded()) {
      m.once("load", open);
      return;
    }
    if (m.isMoving()) {
      m.once("moveend", open);
      return;
    }
    layoutPins();
    if (token !== spotReveal) return;
    pendingSpot = null;
    openPopup(m, spot);
  };
  open();
}

/** 打开页面时应用 ?spot= / ?work=。无效参数静默丢掉，回到默认视图。spot 优先。 */
function applyInitialLink(m: MlMap) {
  const raw = new URLSearchParams(window.location.search);
  const link = readMapLink(window.location.search);
  const spot = link.spot ? spots.find((item) => item.id === link.spot) : undefined;
  if (spot) {
    revealSpot(m, spot);
    return;
  }
  const group = link.work ? groupByWorkId(groups, link.work) : null;
  if (group) {
    focusGroup(group.key);
    return;
  }
  if (raw.has("work") || raw.has("spot")) setLink({ work: null, spot: null });
  fitInitialView(m, 0);
}

onMounted(() => {
  legendMedia = window.matchMedia(LEGEND_NARROW_QUERY);
  onLegendMedia();
  legendMedia.addEventListener("change", onLegendMedia);
  window.addEventListener("pointerdown", onDocPointerDown, true);
  window.addEventListener("keydown", onDocKeydown);
  window.addEventListener("scroll", onAnyScroll, true);
  ensureMapWorker();
  const m = new MlMap({
    container: container.value!,
    style: MAP_STYLE_URL,
    center: [135.78, 34.95],
    zoom: 5,
    pitch: 0,
    maxPitch: 0,
    pitchWithRotate: false,
  });
  map.value = m;
  syncMapOverview(m);
  m.addControl(new NavigationControl(), "bottom-right");
  m.addControl(new PhotoCreditControl(), "bottom-left");
  m.on("style.load", () => {
    simplifyBasemap(m);
    preferCjkLabels(m);
    coverOutsideJapan(m);
  });
  m.on("resize", () => {
    syncMapOverview(m);
    if (popup) {
      const width = popupMaxWidth(m);
      popup.setMaxWidth(width);
      const inner = popup.getElement()?.querySelector(".maplibregl-popup-content > div");
      if (inner instanceof HTMLElement) inner.style.width = width;
      schedulePan(m, popup);
    }
    if (locateToast.value) placeLocateToast();
    scheduleLayout();
  });
  m.on("movestart", onUserCamera);
  m.on("dragstart", onUserCamera);
  m.on("zoomstart", onUserCamera);
  m.on("rotatestart", onUserCamera);
  m.on("error", (e) => {
    const msg = (e.error as Error | undefined)?.message ?? String(e.error);
    console.error("[map]", msg);
    error.value = `地图加载出错：${msg}`;
  });

  for (const g of groups) {
    for (const s of g.spots) {
      const { button, badge, loadThumb } = createThumb(s);
      const marker = new Marker({ element: button, anchor: "bottom" })
        .setLngLat([s.lng, s.lat])
        .addTo(m);
      const pin: Pin = {
        group: g.key,
        spot: s,
        button,
        badge,
        marker,
        offset: { x: 0, y: 0 },
        loadThumb,
      };
      button.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onThumbClick(m, pin);
      });
      const warm = () => warmPopup([pin.spot], 0);
      // 地图在画布容器上听触摸。不拦住的话，点缩略图会被当成拖地图，手机上就打不开弹层。
      const keep = (ev: Event) => ev.stopPropagation();
      button.addEventListener("pointerdown", keep);
      button.addEventListener("mousedown", keep);
      button.addEventListener(
        "touchstart",
        (ev) => {
          ev.stopPropagation();
          warm();
        },
        { passive: true },
      );
      button.addEventListener("pointerenter", warm);
      pins.push(pin);
    }
  }
  applyInitialLink(m);
  m.on("load", scheduleLayout);
  m.on("move", scheduleLayout);
  m.on("moveend", scheduleLayout);
  m.on("idle", scheduleLayout);
  if (m.loaded()) scheduleLayout();
  m.on("click", (e) => {
    const target = e.originalEvent.target as HTMLElement | null;
    if (target?.closest(".maplibregl-marker") || target?.closest(".maplibregl-popup")) return;
    cancelSpotReveal();
    closePopup();
  });
});

onBeforeUnmount(() => {
  legendMedia?.removeEventListener("change", onLegendMedia);
  window.removeEventListener("pointerdown", onDocPointerDown, true);
  window.removeEventListener("keydown", onDocKeydown);
  window.removeEventListener("scroll", onAnyScroll, true);
  window.clearTimeout(eyePressTimer);
  window.clearTimeout(locateTimer);
  window.clearTimeout(toastTimer);
  window.clearTimeout(legendPlaceTimer);
  closePopup({ preserveLink: true });
  map.value?.remove();
});
</script>

<template>
  <div class="relative h-full w-full">
    <!-- maplibre-gl.css 会给容器加 position: relative，所以用 h-full 撑满而不是 absolute inset-0 -->
    <div ref="container" class="h-full w-full" />

    <aside
      data-map-legend
      class="absolute z-10 flex w-max max-w-[calc(70vw+50px)] items-center transition-transform duration-200 ease-out motion-reduce:transition-none"
      :class="
        narrow
          ? legendCollapsed
            ? 'is-collapsed left-0 -translate-x-[calc(100%-44px)]'
            : 'left-0 translate-x-2.5'
          : 'left-2.5'
      "
    >
      <div
        id="map-legend-panel"
        class="min-w-0 max-w-[70vw] rounded bg-white text-xs leading-5 text-[#333] shadow-[0_0_0_2px_rgba(0,0,0,0.1)]"
        :inert="narrow && legendCollapsed"
      >
        <div class="flex items-center pt-1 pr-1.5">
          <h1 class="m-0 min-w-0 flex-1 truncate pl-2.5 font-semibold">巡礼地图</h1>
          <div class="ml-2 flex shrink-0">
            <button
              type="button"
              class="grid h-[29px] w-[29px] shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-black/45 hover:bg-black/5 hover:text-[#333]"
              aria-label="回到默认视图"
              title="回到默认视图"
              @click="resetView"
            >
              <span class="i-lucide-locate-fixed h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="-ml-1.5 grid h-[29px] w-[29px] shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-black/45 hover:bg-black/5 hover:text-[#333]"
              :aria-label="allEyeLabel"
              :title="allEyeLabel"
              :aria-pressed="allShown ? 'true' : noneShown ? 'false' : 'mixed'"
              @click="toggleAllGroups"
            >
              <span
                class="h-4 w-4"
                :class="
                  allShown ? 'i-lucide-eye' : noneShown ? 'i-lucide-eye-off' : 'i-lucide-eye-dashed'
                "
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
        <ul class="m-0 list-none p-1">
          <li
            v-for="g in groups"
            :key="g.key"
            class="flex items-center"
            :class="{ 'opacity-40': hidden.has(g.key) }"
          >
            <span class="ml-1.5 h-2 w-2 shrink-0 rounded-full" :style="{ background: g.color }" />
            <span class="min-w-0 flex-1 truncate px-1.5">{{ g.animeName }}</span>
            <span class="shrink-0 text-black/45">{{ g.spots.length }}</span>
            <div class="ml-2 flex shrink-0 pr-0.5">
              <button
                type="button"
                class="grid h-[29px] w-[29px] shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-black/45 hover:bg-black/5 hover:text-[#333]"
                :aria-label="`定位到${g.animeName}`"
                :title="`定位到${g.animeName}`"
                @click="focusGroup(g.key)"
              >
                <span class="i-lucide-locate-fixed h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="legend-eye -ml-1.5 grid h-[29px] w-[29px] shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-black/45 hover:bg-black/5 hover:text-[#333]"
                :aria-label="hidden.has(g.key) ? `显示${g.animeName}` : `隐藏${g.animeName}`"
                :title="hidden.has(g.key) ? `显示${g.animeName}` : `隐藏${g.animeName}`"
                :aria-pressed="hidden.has(g.key) ? 'false' : 'true'"
                @click="onEyeClick(g.key)"
                @contextmenu="onEyeContextMenu($event, g.key)"
                @pointerdown="onEyePointerDown($event, g.key)"
                @pointermove="onEyePointerMove"
                @pointerup="onEyePointerEnd"
                @pointercancel="onEyePointerEnd"
              >
                <span
                  class="h-4 w-4"
                  :class="hidden.has(g.key) ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  aria-hidden="true"
                />
              </button>
            </div>
          </li>
        </ul>
      </div>
      <button
        v-if="narrow"
        type="button"
        data-legend-handle
        class="group relative -ml-1 h-[52px] w-[50px] shrink-0 border-0 bg-transparent p-0"
        :aria-expanded="!legendCollapsed"
        aria-controls="map-legend-panel"
        :aria-label="legendCollapsed ? '展开图例' : '收起图例'"
        :title="legendCollapsed ? '展开图例' : '收起图例'"
        @click="toggleLegend"
      >
        <span
          class="legend-ear pointer-events-none absolute top-0 flex h-[52px] w-4 items-center justify-center text-black/45 group-hover:text-[#333]"
        >
          <span
            class="h-3 w-3"
            :class="legendCollapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-left'"
            aria-hidden="true"
          />
        </span>
      </button>
    </aside>

    <p
      v-if="locateToast"
      :key="locateToastKey"
      ref="locateToastEl"
      role="status"
      class="locate-toast pointer-events-none absolute z-20 w-max max-w-[calc(100%-20px)] whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs leading-5 text-[#333] shadow-[0_0_0_2px_rgba(0,0,0,0.1)]"
      :style="{ ...locateToastStyle, visibility: locateToastPlaced ? 'visible' : 'hidden' }"
    >
      {{ locateToast }}
    </p>

    <div
      v-if="eyeMenu"
      ref="eyeMenuEl"
      role="menu"
      aria-label="图例操作"
      class="absolute z-30 overflow-hidden rounded bg-white text-xs leading-5 text-[#333] shadow-[0_0_0_2px_rgba(0,0,0,0.1)]"
      :style="{ left: `${eyeMenu.x}px`, top: `${eyeMenu.y}px` }"
      @contextmenu.prevent
    >
      <button
        ref="eyeMenuItem"
        type="button"
        role="menuitem"
        class="block w-full whitespace-nowrap border-0 bg-transparent px-2.5 py-1 text-left text-xs leading-5 text-[#333] hover:bg-black/5"
        @click="showOnlyGroup(eyeMenu.key)"
      >
        仅显示此项
      </button>
    </div>

    <div
      v-if="error"
      role="alert"
      class="absolute top-1/2 left-1/2 z-20 w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded bg-white p-2.5 text-xs leading-5 text-red-700 shadow-[0_0_0_2px_rgba(0,0,0,0.1)]"
    >
      {{ error }}
    </div>
  </div>
</template>

<style>
/* 图例停在安全区下面。top-2.5 是 10px，这里加上 iOS 顶部 inset。 */
[data-map-legend] {
  top: calc(10px + env(safe-area-inset-top, 0px));
}

/*
 * 底边两块署名跟图例面板同一套：
 * rounded bg-white px-2.5 py-1 text-xs leading-5 text-[#333]
 * shadow-[0_0_0_2px_rgba(0,0,0,0.1)]
 * 单行高 28px。声明在左，attribution 在右，底边对齐，不随展开/收起上下跳。
 * 窄屏时 attribution 在声明右侧的剩余宽度里换行，不盖住声明，也不伸进缩放按钮。
 */
.maplibregl-ctrl-bottom-left,
.maplibregl-ctrl-bottom-right {
  bottom: env(safe-area-inset-bottom, 0px);
}

.maplibregl-ctrl-bottom-left {
  left: env(safe-area-inset-left, 0px);
}

.maplibregl-ctrl-bottom-right {
  right: env(safe-area-inset-right, 0px);
}

.photo-credit {
  box-sizing: border-box;
  margin: 0 0 10px 10px;
  padding: 4px 10px;
  border-radius: 4px;
  background: #fff;
  color: #333;
  font-family: system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
}

.photo-credit a,
.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib a {
  color: inherit;
  text-decoration: none;
}

.photo-credit a:hover,
.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib a:hover {
  color: inherit;
  text-decoration: underline;
}

.maplibregl-ctrl-bottom-right > .maplibregl-ctrl.maplibregl-ctrl-attrib {
  box-sizing: border-box;
  float: right;
  clear: both;
  position: relative;
  margin: 0 10px 10px 0;
  border-radius: 4px;
  background: #fff;
  color: #333;
  font-family: system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: 12px;
  line-height: 20px;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
}

.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib.maplibregl-compact-show {
  width: max-content;
  max-width: calc(
    var(--map-width, 100vw) - var(--photo-credit-width, 14rem) - 28px -
      env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)
  );
  min-width: 0;
  min-height: 28px;
  padding: 4px 32px 4px 10px;
}

.maplibregl-ctrl-bottom-right
  > .maplibregl-ctrl-attrib.maplibregl-compact:not(.maplibregl-compact-show) {
  width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
}

.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib .maplibregl-ctrl-attrib-inner {
  white-space: normal;
  overflow-wrap: break-word;
}

.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib .maplibregl-ctrl-attrib-button {
  top: auto;
  right: 0;
  bottom: 0;
  left: auto;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background-color: transparent;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 24px 24px;
}

.maplibregl-ctrl-bottom-right
  > .maplibregl-ctrl-attrib.maplibregl-compact:not(.maplibregl-compact-show)
  .maplibregl-ctrl-attrib-button {
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 28px;
  height: 28px;
}

.maplibregl-ctrl-bottom-right
  > .maplibregl-ctrl-attrib.maplibregl-compact-show
  .maplibregl-ctrl-attrib-button {
  background-color: transparent;
}

.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib .maplibregl-ctrl-attrib-button:hover {
  background-color: rgb(0 0 0 / 5%);
}

/* 与图例面板相同：白底、右侧 4px 圆角、2px 的 10% 黑描边环。相接一侧裁掉描边，避免双线。 */
.legend-ear {
  left: 0;
  background: #fff;
  border-radius: 0 4px 4px 0;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
  clip-path: inset(-2px -2px -2px 0);
  transition: left 200ms ease-out;
}

/* 收起时整卡再往左 6px，把面板和描边都推出屏幕；耳朵右移同样的 6px，仍贴在左边缘。 */
.is-collapsed .legend-ear {
  left: 6px;
}

.group:hover .legend-ear {
  background: #f2f2f2;
}

@media (prefers-reduced-motion: reduce) {
  .legend-ear,
  button.spot-thumb {
    transition: none;
  }

  .spot-thumb-pin.is-pulse,
  .locate-toast {
    animation: none;
  }
}

.maplibregl-popup.spot-popup .maplibregl-popup-content {
  position: relative;
  padding: 0;
  border-radius: 4px;
  background: #fff;
  box-shadow: none;
  color: #333;
  font-size: 12px;
  line-height: 20px;
}

/* 2px、10% 黑的外圈。底边正中留出三角缺口，改由小三角的描边接上，避免两条半透明边叠深。 */
.maplibregl-popup.spot-popup .maplibregl-popup-content::before {
  content: "";
  position: absolute;
  z-index: -1;
  inset: -2px;
  border-radius: 6px;
  background: rgb(0 0 0 / 10%);
  pointer-events: none;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-image:
    linear-gradient(#000 0 0), linear-gradient(#000 0 0), linear-gradient(#000 0 0);
  mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0), linear-gradient(#000 0 0);
  -webkit-mask-size:
    100% calc(100% - 2px),
    calc(50% - 14px) 2px,
    calc(50% - 14px) 2px;
  mask-size:
    100% calc(100% - 2px),
    calc(50% - 14px) 2px,
    calc(50% - 14px) 2px;
  -webkit-mask-position:
    left top,
    left bottom,
    right bottom;
  mask-position:
    left top,
    left bottom,
    right bottom;
}

/* 向下的小三角：白三角盖住内侧，背后的 SVG 只画两条斜边和与浮窗底边相接的那一截，颜色、透明度、粗细与外圈相同。 */
.maplibregl-popup.spot-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip {
  position: relative;
  border-top-color: transparent;
}

.maplibregl-popup.spot-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip::before {
  content: "";
  position: absolute;
  z-index: 0;
  left: -14px;
  top: -10px;
  width: 28px;
  height: 12.828px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='12.828' viewBox='0 0 28 12.828'%3E%3Cpath fill='black' fill-opacity='0.1' d='M0 0L0 2L3.172 2L14 12.828L24.828 2L28 2L28 0L24 0L14 10L4 0Z'/%3E%3C/svg%3E")
    no-repeat center / 100% 100%;
  pointer-events: none;
}

.maplibregl-popup.spot-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip::after {
  content: "";
  position: absolute;
  z-index: 1;
  left: -10px;
  top: -10px;
  width: 0;
  height: 0;
  border-top: 10px solid #fff;
  border-right: 10px solid transparent;
  border-left: 10px solid transparent;
  pointer-events: none;
}

.maplibregl-popup.spot-popup img {
  min-width: 0;
}

button.spot-thumb {
  box-sizing: border-box;
  display: block;
  width: 72px;
  height: 54px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  overflow: visible;
  cursor: pointer;
  font: inherit;
  line-height: 0;
  transition: opacity 180ms ease;
}

button.spot-thumb.is-focus {
  z-index: 4;
}

button.spot-thumb.is-dim {
  opacity: 0.3;
}

.spot-thumb-pin {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  display: block;
  padding: 2px;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
  transform-origin: 50% 100%;
}

.spot-thumb-pin.is-pulse {
  animation: spot-focus-scale 0.9s ease-out 2;
}

@keyframes spot-focus-scale {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.3);
  }
  100% {
    transform: scale(1);
  }
}

button.legend-eye {
  -webkit-touch-callout: none;
  user-select: none;
  touch-action: manipulation;
}

.locate-toast {
  animation: locate-toast 2s ease forwards;
}

@keyframes locate-toast {
  0% {
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  78% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

button.spot-thumb.is-hidden {
  display: none;
}

button.spot-thumb:hover .spot-thumb-pin,
button.spot-thumb:focus-visible .spot-thumb-pin {
  box-shadow: 0 0 0 2px rgb(0 0 0 / 28%);
}

button.spot-thumb:focus-visible {
  outline: 2px solid #333;
  outline-offset: 2px;
}

.spot-thumb-frame {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 2px;
  background: #e6e6e6;
}

.spot-thumb-img {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  object-fit: cover;
  opacity: 0;
}

.spot-thumb-img.is-ready {
  opacity: 1;
}

.spot-thumb-skel {
  position: absolute;
  inset: 0;
  background: #e6e6e6;
  animation: spot-thumb-pulse 1.2s ease-in-out infinite;
}

.spot-thumb-skel.is-error {
  display: grid;
  place-items: center;
  animation: none;
  color: rgb(0 0 0 / 40%);
  font-size: 12px;
  line-height: 20px;
}

@keyframes spot-thumb-pulse {
  50% {
    opacity: 0.55;
  }
}

.spot-thumb-count {
  position: absolute;
  top: -7px;
  right: -7px;
  display: inline-block;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
  color: #333;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  pointer-events: none;
}

.spot-thumb-count[hidden] {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  button.spot-thumb {
    transition: none;
  }

  .spot-thumb-pin.is-pulse,
  .locate-toast {
    animation: none;
  }
}
</style>
