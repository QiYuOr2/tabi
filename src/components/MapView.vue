<script setup lang="ts">
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, Popup } from "maplibre-gl";
import { createApp, onBeforeUnmount, onMounted, ref, shallowRef, type App } from "vue";
import { clusterByDistance, THUMB_GAP, THUMB_H, THUMB_W, type ScreenPoint } from "../lib/cluster";
import { imagePlan, prefetchImage } from "../lib/images";
import { MAP_STYLE_URL, ensureMapWorker, preferCjkLabels } from "../lib/map";
import { groupByAnime, spots } from "../lib/spots";
import type { Spot } from "../types/spot";
import SpotCard from "./SpotCard.vue";

const container = ref<HTMLDivElement>();
const map = shallowRef<MlMap>();
const error = ref<string | null>(null);
const hidden = ref(new Set<string>());

const groups = groupByAnime(spots);
const colorOf = (s: Spot) => groups.find((g) => g.spots.includes(s))?.color ?? "#555";

/** 小于这个经纬跨度就当成同一地点，点击直接开弹层。大约十几米。 */
const SAME_SPOT = 0.00008;
/** 放到这一级仍叠在一起，就不再放大，直接开弹层。 */
const CLUSTER_MAX_ZOOM = 17;

interface Pin {
  group: string;
  spot: Spot;
  button: HTMLButtonElement;
  badge: HTMLSpanElement;
}

const pins: Pin[] = [];
let membersOf = new Map<string, Pin[]>();
let popup: Popup | null = null;
let popupApp: App | null = null;
let selectedId: string | null = null;
let layoutQueued = false;

for (const s of spots) prefetchImage(s.photoThumb ?? null);

function closePopup() {
  selectedId = null;
  popupApp?.unmount();
  popupApp = null;
  popup?.remove();
  popup = null;
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

  const legend = document.querySelector("[data-map-legend]")?.getBoundingClientRect();
  if (
    legend &&
    legend.width > 0 &&
    rect.left < legend.right + margin &&
    rect.top < legend.bottom + margin
  ) {
    minTop = Math.max(minTop, legend.bottom + margin);
  }
  const controls = m.getContainer().querySelector(".maplibregl-ctrl-bottom-right");
  const ctrl = controls?.getBoundingClientRect();
  if (
    ctrl &&
    ctrl.width > 0 &&
    rect.right > ctrl.left - margin &&
    rect.bottom > ctrl.top - margin
  ) {
    maxBottom = Math.min(maxBottom, ctrl.top - margin);
    maxRight = Math.min(maxRight, ctrl.left - margin);
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

/** 图例里仍显示、且彼此落在同一地点阈值内的记录。按 id 稳定排序。 */
function samePlaceSpots(spot: Spot): Spot[] {
  const visible = pins.filter((pin) => !hidden.value.has(pin.group)).map((pin) => pin.spot);
  const parent = visible.map((_, i) => i);
  const find = (i: number): number => {
    let p = i;
    while (parent[p] !== p) p = parent[p]!;
    return p;
  };
  const near = (a: Spot, b: Spot) =>
    Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng)) < SAME_SPOT;
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (!near(visible[i]!, visible[j]!)) continue;
      const pa = find(i);
      const pb = find(j);
      if (pa !== pb) parent[pa] = pb;
    }
  }
  const idx = visible.findIndex((item) => item.id === spot.id);
  if (idx < 0) return [spot];
  const root = find(idx);
  return visible.filter((_, i) => find(i) === root).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function openPopup(m: MlMap, spot: Spot) {
  closePopup();
  const pages = samePlaceSpots(spot);
  const start = Math.max(
    0,
    pages.findIndex((page) => page.id === spot.id),
  );
  selectedId = spot.id;
  for (const page of pages) warmPopup(page);
  const host = document.createElement("div");
  // 先定宽，避免图片固有尺寸把弹层撑开后，平移按旧宽度算偏。
  host.style.width = popupMaxWidth(m);
  popupApp = createApp(SpotCard, {
    spots: pages,
    start,
    colors: pages.map((page) => colorOf(page)),
    onClose: () => closePopup(),
  });
  popupApp.mount(host);

  const next = new Popup({
    closeButton: false,
    closeOnClick: false,
    anchor: "bottom",
    offset: THUMB_H + 8,
    maxWidth: popupMaxWidth(m),
    className: "spot-popup",
    focusAfterOpen: false,
  })
    .setLngLat([spot.lng, spot.lat])
    .setDOMContent(host)
    .addTo(m);
  popup = next;
  next.on("close", () => {
    if (popup !== next) return;
    popupApp?.unmount();
    popupApp = null;
    popup = null;
    selectedId = null;
  });
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
  if (shown) pin.button.removeAttribute("aria-hidden");
  else pin.button.setAttribute("aria-hidden", "true");
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

  const clusters = clusterByDistance(projected, THUMB_W + THUMB_GAP, THUMB_H + THUMB_GAP);
  const nextMembers = new Map<string, Pin[]>();

  for (const cluster of clusters) {
    const items = cluster.map((point) => point.item);
    for (const pin of items) nextMembers.set(pin.spot.id, items);

    const onScreen = cluster.filter((point) => {
      const left = point.x - THUMB_W / 2;
      const right = point.x + THUMB_W / 2;
      const top = point.y - THUMB_H / 2;
      const bottom = point.y + THUMB_H / 2;
      return right > 0 && left < width && bottom > 0 && top < height;
    });
    if (onScreen.length === 0) {
      for (const pin of items) setShown(pin, false);
      continue;
    }

    onScreen.sort((a, b) => (a.item.spot.id < b.item.spot.id ? -1 : 1));
    const rep = onScreen[0]!.item;
    for (const pin of items) setShown(pin, pin === rep);

    const count = items.length;
    const samePlace = spreadOf(items) < SAME_SPOT;
    if (count > 1) {
      rep.badge.hidden = false;
      rep.badge.textContent = String(count);
      const label = samePlace
        ? `${rep.spot.animeName} · ${count} 张照片`
        : `${rep.spot.animeName} · ${count} 个地点`;
      rep.button.title = label;
      rep.button.setAttribute("aria-label", `${label}，${samePlace ? "点击查看" : "点击放大"}`);
    } else {
      rep.badge.hidden = true;
      rep.badge.textContent = "";
      const label = `${rep.spot.animeName} · ${rep.spot.pointName}`;
      rep.button.title = label;
      rep.button.setAttribute("aria-label", label);
    }
    const img = rep.button.querySelector("img");
    if (!img || img.classList.contains("is-ready")) {
      for (const page of samePlaceSpots(rep.spot)) warmPopup(page);
    }
  }

  membersOf = nextMembers;
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
  const members = membersOf.get(pin.spot.id) ?? [pin];
  if (members.length <= 1 || spreadOf(members) < SAME_SPOT || m.getZoom() >= CLUSTER_MAX_ZOOM) {
    openPopup(m, pin.spot);
    return;
  }
  const bounds = new LngLatBounds();
  for (const member of members) bounds.extend([member.spot.lng, member.spot.lat]);
  closePopup();
  const view = Math.min(m.getContainer().clientWidth, m.getContainer().clientHeight);
  const padding = Math.max(48, Math.min(100, Math.round(view * 0.2)));
  m.fitBounds(bounds, { padding, maxZoom: CLUSTER_MAX_ZOOM, duration: 400 });
}

/** 缩略图已经在画面上时，把弹层要用的动画截图和实拍原图先拉下来。 */
function warmPopup(spot: Spot) {
  prefetchImage(imagePlan(spot.animeImage, "h360"));
  if (spot.photo) prefetchImage(spot.photo);
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
    const reveal = () => {
      ready();
      if (!button.classList.contains("is-hidden")) warmPopup(spot);
    };
    img.addEventListener("load", reveal);
    img.addEventListener("error", () => {
      if (!usingFallback && fallback && fallback !== primary) {
        usingFallback = true;
        img.src = fallback;
        if (img.complete && img.naturalWidth > 0) reveal();
        return;
      }
      skel.classList.add("is-error");
      skel.textContent = "无";
    });
    frame.append(img, skel);
    img.src = src;
    if (img.complete && img.naturalWidth > 0) reveal();
  } else {
    skel.classList.add("is-error");
    skel.textContent = "无";
    frame.append(skel);
  }

  const badge = document.createElement("span");
  badge.className = "spot-thumb-count";
  badge.hidden = true;
  button.append(frame, badge);
  return { button, badge };
}

function toggleGroup(key: string) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
  const selected = pins.find((item) => item.spot.id === selectedId);
  if (selected && next.has(selected.group)) closePopup();
  scheduleLayout();
}

onMounted(() => {
  ensureMapWorker();
  const m = new MlMap({
    container: container.value!,
    style: MAP_STYLE_URL,
    center: [135.78, 34.95],
    zoom: 5,
  });
  map.value = m;
  m.addControl(new NavigationControl(), "bottom-right");
  m.on("style.load", () => preferCjkLabels(m));
  m.on("resize", () => {
    if (popup) {
      const width = popupMaxWidth(m);
      popup.setMaxWidth(width);
      const inner = popup.getElement()?.querySelector(".maplibregl-popup-content > div");
      if (inner instanceof HTMLElement) inner.style.width = width;
      schedulePan(m, popup);
    }
    scheduleLayout();
  });
  m.on("error", (e) => {
    const msg = (e.error as Error | undefined)?.message ?? String(e.error);
    console.error("[map]", msg);
    error.value = `地图加载出错：${msg}`;
  });

  const bounds = new LngLatBounds();
  for (const g of groups) {
    for (const s of g.spots) {
      const { button, badge } = createThumb(s);
      new Marker({ element: button, anchor: "bottom" }).setLngLat([s.lng, s.lat]).addTo(m);
      const pin: Pin = { group: g.key, spot: s, button, badge };
      button.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onThumbClick(m, pin);
      });
      const warm = () => warmPopup(pin.spot);
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
      bounds.extend([s.lng, s.lat]);
    }
  }
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 0 });
  m.on("load", scheduleLayout);
  m.on("move", scheduleLayout);
  m.on("moveend", scheduleLayout);
  m.on("idle", scheduleLayout);
  if (m.loaded()) scheduleLayout();
  m.on("click", (e) => {
    const target = e.originalEvent.target as HTMLElement | null;
    if (target?.closest(".maplibregl-marker") || target?.closest(".maplibregl-popup")) return;
    closePopup();
  });
});

onBeforeUnmount(() => {
  closePopup();
  map.value?.remove();
});
</script>

<template>
  <div class="relative h-full w-full">
    <!-- maplibre-gl.css 会给容器加 position: relative，所以用 h-full 撑满而不是 absolute inset-0 -->
    <div ref="container" class="h-full w-full" />

    <aside
      data-map-legend
      class="absolute top-2.5 left-2.5 z-10 max-w-[70vw] rounded bg-white text-xs leading-5 text-[#333] shadow-[0_0_0_2px_rgba(0,0,0,0.1)]"
    >
      <h1 class="m-0 px-2.5 pt-1.5 font-semibold">巡礼地图</h1>
      <ul class="m-0 list-none p-1">
        <li v-for="g in groups" :key="g.key">
          <button
            type="button"
            class="flex h-[29px] w-full items-center gap-1.5 rounded border-0 bg-transparent px-1.5 text-left text-xs text-[#333] hover:bg-black/5"
            :class="{ 'opacity-40': hidden.has(g.key) }"
            @click="toggleGroup(g.key)"
          >
            <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: g.color }" />
            <span class="truncate">{{ g.animeName }}</span>
            <span class="ml-auto text-black/45">{{ g.spots.length }}</span>
          </button>
        </li>
      </ul>
    </aside>

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
.maplibregl-popup.spot-popup .maplibregl-popup-content {
  padding: 0;
  border-radius: 4px;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
  color: #333;
  font-size: 12px;
  line-height: 20px;
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
  padding: 2px;
  border: 0;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 10%);
  cursor: pointer;
  font: inherit;
  line-height: 0;
}

button.spot-thumb.is-hidden {
  display: none;
}

button.spot-thumb:hover,
button.spot-thumb:focus-visible {
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
</style>
