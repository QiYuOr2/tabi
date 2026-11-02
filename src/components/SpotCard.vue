<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { imagePlan, prefetchImage } from "../lib/images";
import { workName } from "../lib/spots";
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
const hasAnitabiLink = computed(
  () => spot.value.anitabiPointId != null && spot.value.bangumiId != null,
);
const googleMapsUrl = computed(
  () => `https://www.google.com/maps/search/?api=1&query=${spot.value.lat},${spot.value.lng}`,
);

const animeSrc = computed(() => imagePlan(spot.value.animeImage, "h360"));
const animeFailed = ref(false);
const animeLoaded = ref(false);
const photoFailed = ref(false);
const photoLoaded = ref(false);
const lightbox = ref(false);
const lightboxFailed = ref(false);
const canZoomPhoto = computed(() => Boolean(spot.value.photo) && !photoFailed.value);

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
  lightboxFailed.value = false;
  index.value = i;
  warm(i);
}

function openLightbox() {
  if (!canZoomPhoto.value) return;
  lightboxFailed.value = false;
  lightbox.value = true;
}

function closeLightbox() {
  lightbox.value = false;
}

function onKey(ev: KeyboardEvent) {
  if (lightbox.value && ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeLightbox();
    return;
  }
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

let lightboxTracking = false;
let lightboxDownOnImage = false;

function onLightboxPointerDown(ev: PointerEvent) {
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  const target = ev.target as HTMLElement | null;
  if (target?.closest("button")) return;
  lightboxDownOnImage = Boolean(target?.closest("img"));
  lightboxTracking = true;
  swipeX = ev.clientX;
  swipeY = ev.clientY;
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
}

function onLightboxPointerUp(ev: PointerEvent) {
  if (!lightboxTracking) return;
  lightboxTracking = false;
  const dx = ev.clientX - swipeX;
  const dy = ev.clientY - swipeY;
  if (Math.abs(dx) >= 36 && Math.abs(dx) > Math.abs(dy)) {
    show(index.value + (dx < 0 ? 1 : -1));
    return;
  }
  if (!lightboxDownOnImage) closeLightbox();
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
        <p class="m-0 text-black/55">{{ workName(spot) }}</p>
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
          <button
            v-if="spot.photo && !photoFailed"
            type="button"
            class="block w-full cursor-zoom-in border-0 bg-transparent p-0"
            aria-label="查看大图"
            @click="openLightbox"
          >
            <img
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
          </button>
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
        <figcaption class="mt-0.5 flex h-5 items-center text-black/55">
          <span>实拍</span>
          <button
            v-if="canZoomPhoto"
            type="button"
            class="ml-auto grid h-5 w-5 shrink-0 place-items-center border-0 bg-transparent p-0 text-black/45 hover:text-[#333]"
            aria-label="查看大图"
            title="查看大图"
            @click="openLightbox"
          >
            <span class="i-lucide-zoom-in h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </figcaption>
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
      <span class="min-w-0 flex-1 text-center text-black/55">{{ index + 1 }} / {{ total }}</span>
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

    <p v-if="spot.note" class="m-0 px-2.5 pt-1.5 text-black/55">{{ spot.note }}</p>
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

    <div class="mt-1.5 border-t border-[#ddd]">
      <div v-if="hasAnitabiLink" class="flex">
        <a
          :href="`https://www.anitabi.cn/map?bangumiId=${spot.bangumiId}&pid=${spot.anitabiPointId}`"
          target="_blank"
          rel="noopener"
          class="flex h-[29px] min-w-0 flex-1 items-center justify-center whitespace-nowrap text-[#333] no-underline hover:bg-black/5"
        >
          在anitabi查看
        </a>
        <span
          class="w-px shrink-0 self-stretch bg-[#ddd]"
          data-action-divider
          aria-hidden="true"
        ></span>
        <a
          :href="googleMapsUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="flex h-[29px] min-w-0 flex-1 items-center justify-center whitespace-nowrap text-[#333] no-underline hover:bg-black/5"
        >
          在谷歌地图查看
        </a>
      </div>
      <a
        v-else
        :href="googleMapsUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="flex h-[29px] w-full items-center whitespace-nowrap px-2.5 text-[#333] no-underline hover:bg-black/5"
      >
        在谷歌地图查看
      </a>
    </div>

    <Teleport to="body">
      <div
        v-if="lightbox"
        class="fixed inset-0 z-[80] flex flex-col bg-black/80 text-white"
        role="dialog"
        aria-modal="true"
        aria-label="实拍大图"
        @pointerdown="onLightboxPointerDown"
        @pointerup="onLightboxPointerUp"
        @pointercancel="lightboxTracking = false"
      >
        <div class="flex shrink-0 justify-end p-2">
          <button
            type="button"
            class="grid h-11 w-11 place-items-center border-0 bg-transparent p-0 text-2xl leading-none text-white hover:bg-white/10"
            aria-label="关闭"
            @click="closeLightbox"
          >
            ×
          </button>
        </div>
        <div class="flex min-h-0 flex-1 items-center justify-center px-4">
          <img
            v-if="spot.photo && !lightboxFailed"
            :key="spot.id"
            :src="spot.photo"
            alt="实拍"
            class="max-h-full max-w-full object-contain"
            referrerpolicy="no-referrer"
            decoding="async"
            draggable="false"
            @error="lightboxFailed = true"
          />
          <p v-else class="m-0 text-white/70">{{ spot.photo ? "图片加载失败" : "暂无实拍" }}</p>
        </div>
        <div v-if="total > 1" class="flex shrink-0 justify-center px-3 pt-2 pb-4">
          <div
            class="flex w-[min(100%,240px)] items-center rounded bg-white px-1 text-xs text-[#333]"
          >
            <button
              type="button"
              class="h-[29px] w-[29px] shrink-0 rounded border-0 bg-transparent p-0 text-lg leading-[29px] text-[#333] hover:bg-black/5 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="上一张"
              :disabled="index === 0"
              @click="show(index - 1)"
            >
              ‹
            </button>
            <span class="min-w-0 flex-1 text-center text-black/55"
              >{{ index + 1 }} / {{ total }}</span
            >
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
        </div>
        <div v-else class="h-11 shrink-0"></div>
      </div>
    </Teleport>
  </article>
</template>
