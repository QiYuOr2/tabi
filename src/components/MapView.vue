<script setup lang="ts">
import { LngLatBounds, Map, Marker, NavigationControl, Popup } from "maplibre-gl";
import { createApp, onBeforeUnmount, onMounted, ref, shallowRef, type App } from "vue";
import { MAP_STYLE_URL, ensureMapWorker, preferCjkLabels } from "../lib/map";
import { groupByAnime, spots } from "../lib/spots";
import type { Spot } from "../types/spot";
import SpotCard from "./SpotCard.vue";

const container = ref<HTMLDivElement>();
const map = shallowRef<Map>();
const error = ref<string | null>(null);
const hidden = ref(new Set<string>());

const groups = groupByAnime(spots);
const colorOf = (s: Spot) => groups.find((g) => g.spots.includes(s))?.color ?? "#555";

const markers: { group: string; spot: Spot; marker: Marker }[] = [];
let popup: Popup | null = null;
let popupApp: App | null = null;
let selectedId: string | null = null;

function closePopup() {
  selectedId = null;
  popupApp?.unmount();
  popupApp = null;
  popup?.remove();
  popup = null;
}

function popupMaxWidth(m: Map) {
  const width = m.getContainer().clientWidth;
  return `${Math.max(160, Math.min(300, width - 24))}px`;
}

/** 弹层超出地图或盖住图例/缩放按钮时，平移地图把它挪进可视区域。 */
function panPopupIntoView(m: Map, p: Popup) {
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
  if (x !== 0 || y !== 0) m.panBy([x, y], { duration: 200 });
}

function schedulePan(m: Map, p: Popup) {
  // 等弹层完成布局再量尺寸，否则宽度还是 0，平移不会发生。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (popup === p) panPopupIntoView(m, p);
    });
  });
}

function openPopup(m: Map, spot: Spot) {
  closePopup();
  selectedId = spot.id;
  const host = document.createElement("div");
  // 先定宽，避免图片固有尺寸把弹层撑开后，平移按旧宽度算偏。
  host.style.width = popupMaxWidth(m);
  popupApp = createApp(SpotCard, {
    spot,
    color: colorOf(spot),
    onClose: () => closePopup(),
  });
  popupApp.mount(host);

  const marker = markers.find((item) => item.spot === spot)?.marker;
  const pinHeight = marker?.getElement().offsetHeight ?? 41;
  const next = new Popup({
    closeButton: false,
    closeOnClick: false,
    anchor: "bottom",
    offset: pinHeight + 6,
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

function toggleGroup(key: string) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
  for (const item of markers) {
    item.marker.getElement().style.display = next.has(item.group) ? "none" : "";
  }
  const selected = markers.find((item) => item.spot.id === selectedId);
  if (selected && next.has(selected.group)) closePopup();
}

onMounted(() => {
  ensureMapWorker();
  const m = new Map({
    container: container.value!,
    style: MAP_STYLE_URL,
    center: [135.78, 34.95],
    zoom: 5,
  });
  map.value = m;
  m.addControl(new NavigationControl(), "bottom-right");
  m.on("style.load", () => preferCjkLabels(m));
  m.on("resize", () => {
    if (!popup) return;
    const width = popupMaxWidth(m);
    popup.setMaxWidth(width);
    const inner = popup.getElement()?.querySelector(".maplibregl-popup-content > div");
    if (inner instanceof HTMLElement) inner.style.width = width;
    schedulePan(m, popup);
  });
  m.on("error", (e) => {
    const msg = (e.error as Error | undefined)?.message ?? String(e.error);
    console.error("[map]", msg);
    error.value = `地图加载出错：${msg}`;
  });

  const bounds = new LngLatBounds();
  for (const g of groups) {
    for (const s of g.spots) {
      const marker = new Marker({ color: g.color }).setLngLat([s.lng, s.lat]).addTo(m);
      const el = marker.getElement();
      el.style.cursor = "pointer";
      el.title = `${s.animeName} · ${s.pointName}`;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openPopup(m, s);
      });
      markers.push({ group: g.key, spot: s, marker });
      bounds.extend([s.lng, s.lat]);
    }
  }
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 0 });
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
</style>
