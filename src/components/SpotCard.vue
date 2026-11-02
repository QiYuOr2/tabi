<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { imagePlan, prefetchImage } from "../lib/images";
import type { Spot } from "../types/spot";

const props = defineProps<{
  spots: Spot[];
  start: number;
  colors: string[];
  onClose: () => void;
}>();

const index = ref(Math.min(Math.max(props.start, 0), Math.max(props.spots.length - 1, 0)));
const spot = computed(() => props.spots[index.value] ?? props.spots[0]!);
const color = computed(() => props.colors[index.value] ?? props.colors[0] ?? "#555");
const total = computed(() => props.spots.length);

const animeSrc = computed(() => imagePlan(spot.value.animeImage, "h360"));
const animeFailed = ref(false);
const animeLoaded = ref(false);
const photoFailed = ref(false);
const photoLoaded = ref(false);

const SOURCE_LABEL: Record<Spot["source"], string> = {
  exif: "照片 EXIF",
  anitabi: "anitabi 匹配",
  geocode: "地理编码",
  manual: "手动标注",
};

function warm(i: number) {
  const page = props.spots[i];
  if (!page) return;
  prefetchImage(imagePlan(page.animeImage, "h360"));
  if (page.photo) prefetchImage(page.photo);
}

function show(i: number) {
  if (i === index.value || i < 0 || i >= props.spots.length) return;
  animeFailed.value = false;
  animeLoaded.value = false;
  photoFailed.value = false;
  photoLoaded.value = false;
  index.value = i;
  warm(i);
}

function onKey(ev: KeyboardEvent) {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  ev.stopPropagation();
  show(index.value + (ev.key === "ArrowRight" ? 1 : -1));
}

let swipeX = 0;
let swipeY = 0;
let tracking = false;

function onPointerDown(ev: PointerEvent) {
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  const target = ev.target as HTMLElement | null;
  if (target?.closest("button, a")) return;
  tracking = true;
  swipeX = ev.clientX;
  swipeY = ev.clientY;
  ev.stopPropagation();
  ev.preventDefault();
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
}

function onPointerUp(ev: PointerEvent) {
  if (!tracking) return;
  tracking = false;
  const dx = ev.clientX - swipeX;
  const dy = ev.clientY - swipeY;
  if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy)) return;
  show(index.value + (dx < 0 ? 1 : -1));
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <article
    class="relative text-xs leading-5 text-[#333]"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="tracking = false"
    @touchstart.stop
    @touchmove.prevent.stop
  >
    <header class="flex items-start gap-1.5 px-2.5 pt-2 pr-7">
      <span class="mt-[6px] h-2 w-2 shrink-0 rounded-full" :style="{ background: color }" />
      <div class="min-w-0 flex-1">
        <p class="m-0 text-black/55">{{ spot.animeName }}</p>
        <h2 class="m-0 font-semibold leading-5">{{ spot.pointName }}</h2>
      </div>
      <button
        type="button"
        class="absolute top-0 right-0 h-[29px] w-[29px] border-0 bg-transparent p-0 text-lg leading-[29px] text-[#333] hover:bg-black/5"
        aria-label="关闭"
        @click="onClose"
      >
        ×
      </button>
    </header>

    <div
      :key="spot.id"
      class="grid gap-1 px-2.5 pt-1.5"
      :class="animeSrc ? 'grid-cols-2' : 'grid-cols-1'"
    >
      <figure v-if="animeSrc" class="m-0">
        <div class="relative">
          <img
            v-if="!animeFailed"
            :src="animeSrc"
            alt="动画截图"
            class="aspect-video w-full rounded-sm bg-[#f2f2f2] object-cover"
            :class="animeLoaded ? 'opacity-100' : 'opacity-0'"
            referrerpolicy="no-referrer"
            decoding="async"
            draggable="false"
            fetchpriority="high"
            @load="animeLoaded = true"
            @error="animeFailed = true"
          />
          <div
            v-if="!animeFailed && !animeLoaded"
            class="pointer-events-none absolute inset-0 animate-pulse rounded-sm bg-[#e6e6e6]"
          />
          <div
            v-else-if="animeFailed"
            class="grid aspect-video w-full place-items-center rounded-sm bg-[#f2f2f2] text-black/40"
          >
            图片加载失败
          </div>
        </div>
        <figcaption class="mt-0.5 text-black/55">动画</figcaption>
      </figure>
      <figure class="m-0">
        <div class="relative">
          <img
            v-if="spot.photo && !photoFailed"
            :src="spot.photo"
            alt="实拍"
            class="aspect-video w-full rounded-sm bg-[#f2f2f2] object-cover"
            :class="photoLoaded ? 'opacity-100' : 'opacity-0'"
            referrerpolicy="no-referrer"
            decoding="async"
            draggable="false"
            @load="photoLoaded = true"
            @error="photoFailed = true"
          />
          <div
            v-if="spot.photo && !photoFailed && !photoLoaded"
            class="pointer-events-none absolute inset-0 animate-pulse rounded-sm bg-[#e6e6e6]"
          />
          <div
            v-else-if="!spot.photo || photoFailed"
            class="grid aspect-video w-full place-items-center rounded-sm bg-[#f2f2f2] text-black/40"
          >
            {{ spot.photo ? "图片加载失败" : "暂无实拍" }}
          </div>
        </div>
        <figcaption class="mt-0.5 text-black/55">实拍</figcaption>
      </figure>
    </div>

    <div v-if="total > 1" class="mt-1 flex items-center px-1">
      <button
        type="button"
        class="h-[29px] w-[29px] shrink-0 rounded border-0 bg-transparent p-0 text-lg leading-[29px] text-[#333] hover:bg-black/5 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="上一张"
        :disabled="index === 0"
        @click="show(index - 1)"
      >
        ‹
      </button>
      <div class="flex min-w-0 flex-1 items-center justify-center gap-0.5">
        <button
          v-for="(page, i) in spots"
          :key="page.id"
          type="button"
          class="grid h-[29px] w-[18px] place-items-center border-0 bg-transparent p-0"
          :aria-label="`第 ${i + 1} 张，共 ${total} 张`"
          :aria-current="i === index ? 'true' : undefined"
          @click="show(i)"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="i === index ? 'bg-[#333]' : 'bg-black/25'"
          />
        </button>
        <span class="ml-1 text-black/55">{{ index + 1 }} / {{ total }}</span>
      </div>
      <button
        type="button"
        class="h-[29px] w-[29px] shrink-0 rounded border-0 bg-transparent p-0 text-lg leading-[29px] text-[#333] hover:bg-black/5 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="下一张"
        :disabled="index === total - 1"
        @click="show(index + 1)"
      >
        ›
      </button>
    </div>

    <p class="m-0 flex flex-wrap gap-x-2.5 px-2.5 pt-1.5 text-black/55">
      <span>坐标：{{ SOURCE_LABEL[spot.source] }}</span>
      <span v-if="spot.takenAt">拍摄：{{ spot.takenAt.slice(0, 10) }}</span>
      <a
        v-if="spot.origin && spot.originURL"
        :href="spot.originURL"
        target="_blank"
        rel="noopener"
        class="text-black/75 hover:underline"
        >截图来源：{{ spot.origin }}</a
      >
    </p>

    <a
      v-if="spot.anitabiPointId && spot.bangumiId != null"
      :href="`https://www.anitabi.cn/map?bangumiId=${spot.bangumiId}&pid=${spot.anitabiPointId}`"
      target="_blank"
      rel="noopener"
      class="mt-1.5 flex h-[29px] items-center border-t border-[#ddd] px-2.5 text-[#333] no-underline hover:bg-black/5"
    >
      在 anitabi 查看此地标
    </a>
  </article>
</template>
