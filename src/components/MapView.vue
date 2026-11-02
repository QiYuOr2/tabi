<script setup lang="ts">
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, Popup } from "maplibre-gl";
import { createApp, onBeforeUnmount, onMounted, ref, shallowRef, type App } from "vue";
import { clusterByDistance, THUMB_GAP, THUMB_H, THUMB_W, type ScreenPoint } from "../lib/cluster";
import { imagePlan, prefetchImage } from "../lib/images";
import {
  MAP_STYLE_URL,
  coverOutsideJapan,
  ensureMapWorker,
  preferCjkLabels,
  simplifyBasemap,
  syncMapOverview,
} from "../lib/map";
import { PhotoCreditControl } from "../lib/photo-credit-control";
import { groupByAnime, spots } from "../lib/spots";
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

/** 锚点之间至少隔开一个图钉加缝，斜向放置时也不会叠住。 */
function ringOffsets(count: number) {
  if (count <= 1) return [{ x: 0, y: 0 }];
  const minDist = THUMB_W + THUMB_GAP + 12;
  const radius = count === 2 ? minDist / 2 : minDist / (2 * Math.sin(Math.PI / count));
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    offsets.push({
      x: Math.round(Math.cos(angle) * radius),
      y: Math.round(Math.sin(angle) * radius),
    });
  }
  return offsets;
}

function placePin(pin: Pin, x: number, y: number) {
  if (pin.offset.x === x && pin.offset.y === y) return;
  pin.offset = { x, y };
  pin.marker.setOffset([x, y]);
}

function openPopup(m: MlMap, spot: Spot) {
  closePopup();
  const pages = scenePages(spot);
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

  const shift = pins.find((pin) => pin.spot.id === spot.id)?.offset ?? { x: 0, y: 0 };
  const next = new Popup({
    closeButton: false,
    closeOnClick: false,
    anchor: "bottom",
    offset: [shift.x, shift.y - (THUMB_H + 8)],
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

    onScreen.sort((a, b) => bySpotId(a.item, b.item));
    const scenes = sceneGroups(items);
    const present = scenes.filter((scene) =>
      scene.some((pin) => onScreen.some((point) => point.item === pin)),
    );
    const fan = present.length > 1 && m.getZoom() >= CLUSTER_MAX_ZOOM - 1e-6;
    if (!fan) {
      const rep = onScreen[0]!.item;
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
      const img = rep.button.querySelector("img");
      if (!img || img.classList.contains("is-ready")) {
        for (const page of scenePages(rep.spot)) warmPopup(page);
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
    const offsets = ringOffsets(present.length);
    const shown = new Set<Pin>();
    present.forEach((scene, index) => {
      const rep = scene.find((pin) => onScreen.some((point) => point.item === pin))!;
      shown.add(rep);
      const at = onScreen.find((point) => point.item === rep)!;
      const anchorX = at.x;
      const anchorY = at.y + THUMB_H / 2;
      const shift = offsets[index] ?? { x: 0, y: 0 };
      placePin(rep, Math.round(cx + shift.x - anchorX), Math.round(cy + shift.y - anchorY));
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
      const img = rep.button.querySelector("img");
      if (!img || img.classList.contains("is-ready")) {
        for (const page of scene) warmPopup(page.spot);
      }
    });
    for (const pin of items) setShown(pin, shown.has(pin));
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

/** 只有一个地点时飞到这一级，多地点的包围盒也不会放得比这更近。 */
const FOCUS_ZOOM = 16;

function focusGroup(key: string) {
  const m = map.value;
  const group = groups.find((item) => item.key === key);
  if (!m || !group || group.spots.length === 0) return;
  if (hidden.value.has(key)) {
    const next = new Set(hidden.value);
    next.delete(key);
    hidden.value = next;
    scheduleLayout();
  }
  closePopup();
  if (group.spots.length === 1) {
    const spot = group.spots[0]!;
    m.flyTo({ center: [spot.lng, spot.lat], zoom: FOCUS_ZOOM, duration: 400 });
    return;
  }
  const bounds = new LngLatBounds();
  for (const spot of group.spots) bounds.extend([spot.lng, spot.lat]);
  const view = Math.min(m.getContainer().clientWidth, m.getContainer().clientHeight);
  const padding = Math.max(48, Math.min(80, Math.round(view * 0.12)));
  m.fitBounds(bounds, {
    padding: { top: padding + 40, right: padding, bottom: padding, left: padding + 24 },
    maxZoom: FOCUS_ZOOM,
    duration: 400,
  });
}

onMounted(() => {
  legendMedia = window.matchMedia(LEGEND_NARROW_QUERY);
  onLegendMedia();
  legendMedia.addEventListener("change", onLegendMedia);
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
      const marker = new Marker({ element: button, anchor: "bottom" })
        .setLngLat([s.lng, s.lat])
        .addTo(m);
      const pin: Pin = { group: g.key, spot: s, button, badge, marker, offset: { x: 0, y: 0 } };
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
  legendMedia?.removeEventListener("change", onLegendMedia);
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
      class="absolute top-2.5 z-10 flex w-max max-w-[calc(70vw+50px)] items-center transition-transform duration-200 ease-out motion-reduce:transition-none"
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
        <h1 class="m-0 px-2.5 pt-1.5 font-semibold">巡礼地图</h1>
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
                class="-ml-1.5 grid h-[29px] w-[29px] shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-black/45 hover:bg-black/5 hover:text-[#333]"
                :aria-label="hidden.has(g.key) ? `显示${g.animeName}` : `隐藏${g.animeName}`"
                :title="hidden.has(g.key) ? `显示${g.animeName}` : `隐藏${g.animeName}`"
                :aria-pressed="hidden.has(g.key) ? 'false' : 'true'"
                @click="toggleGroup(g.key)"
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
  .legend-ear {
    transition: none;
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
