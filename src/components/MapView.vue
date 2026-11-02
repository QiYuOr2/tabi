<script setup lang="ts">
import { LngLatBounds, Map, Marker, NavigationControl } from "maplibre-gl";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { MAP_STYLE_URL, ensureMapWorker, preferCjkLabels } from "../lib/map";
import { groupByAnime, spots } from "../lib/spots";
import type { Spot } from "../types/spot";
import SpotCard from "./SpotCard.vue";

const container = ref<HTMLDivElement>();
const map = shallowRef<Map>();
const selected = shallowRef<Spot | null>(null);
const error = ref<string | null>(null);
const hidden = ref(new Set<string>());

const groups = groupByAnime(spots);
const colorOf = (s: Spot) => groups.find((g) => g.spots.includes(s))?.color ?? "#555";
const selectedColor = computed(() => (selected.value ? colorOf(selected.value) : "#555"));

const markers: { group: string; marker: Marker }[] = [];

function toggleGroup(key: string) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
  for (const m of markers) {
    m.marker.getElement().style.display = next.has(m.group) ? "none" : "";
  }
  if (selected.value && next.has(groups.find((g) => g.spots.includes(selected.value!))!.key)) {
    selected.value = null;
  }
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
        selected.value = s;
        m.easeTo({ center: [s.lng, s.lat], zoom: Math.max(m.getZoom(), 13) });
      });
      markers.push({ group: g.key, marker });
      bounds.extend([s.lng, s.lat]);
    }
  }
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: 0 });
  m.on("click", (e) => {
    // 点图钉时 MapLibre 也会触发 map click，这里忽略来自图钉的点击
    const target = e.originalEvent.target as HTMLElement | null;
    if (target?.closest(".maplibregl-marker")) return;
    selected.value = null;
  });
});

onBeforeUnmount(() => map.value?.remove());
</script>

<template>
  <div class="relative h-full w-full">
    <!-- maplibre-gl.css 会给容器加 position: relative，所以用 h-full 撑满而不是 absolute inset-0 -->
    <div ref="container" class="h-full w-full" />

    <aside
      class="absolute z-10 left-3 top-3 max-w-[70vw] rounded-xl bg-white/90 p-3 shadow backdrop-blur text-sm text-gray-800"
    >
      <h1 class="m-0 mb-2 text-base font-semibold">巡礼地图</h1>
      <ul class="m-0 list-none p-0 space-y-1">
        <li v-for="g in groups" :key="g.key">
          <button
            class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-gray-100"
            :class="{ 'opacity-40': hidden.has(g.key) }"
            @click="toggleGroup(g.key)"
          >
            <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: g.color }" />
            <span class="truncate">{{ g.animeName }}</span>
            <span class="ml-auto text-xs text-gray-400">{{ g.spots.length }}</span>
          </button>
        </li>
      </ul>
    </aside>

    <SpotCard v-if="selected" :spot="selected" :color="selectedColor" @close="selected = null" />

    <div
      v-if="error"
      role="alert"
      class="absolute z-20 left-1/2 top-1/2 w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-4 text-sm text-red-700 shadow-xl"
    >
      {{ error }}
    </div>
  </div>
</template>
