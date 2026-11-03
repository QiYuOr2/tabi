<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { imagePlan, photoMedium, prefetchImage } from "../lib/images";
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
const photoUseOriginal = ref(false);
const lightbox = ref(false);
const lightboxFailed = ref(false);
const canZoomPhoto = computed(() => Boolean(spot.value.photo) && !photoFailed.value);
const photoSrc = computed(() => {
  const original = spot.value.photo;
  if (!original) return null;
  if (photoUseOriginal.value) return original;
  return photoMedium(original) ?? original;
});

/** 当前页和前后各一页。动画截图仍是 h360；实拍只预取 640 中图。 */
function warm(i: number) {
  for (let n = i - 1; n <= i + 1; n++) {
    const page = props.spots[n];
    if (!page) continue;
    prefetchImage(imagePlan(page.animeImage, "h360"));
    prefetchImage(photoMedium(page.photo));
  }
}

function onPhotoError(ev: Event) {
  const original = spot.value.photo;
  const medium = original ? photoMedium(original) : null;
  const current = ev.target instanceof HTMLImageElement ? ev.target.getAttribute("src") : null;
  if (medium && original && current === medium && medium !== original) {
    photoUseOriginal.value = true;
    photoLoaded.value = false;
    return;
  }
  photoFailed.value = true;
}

function show(i: number) {
  if (i === index.value || i < 0 || i >= props.spots.length) return;
  animeFailed.value = false;
  animeLoaded.value = false;
  photoFailed.value = false;
  photoLoaded.value = false;
  photoUseOriginal.value = false;
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

onMounted(() => {
  warm(index.value);
  window.addEventListener("keydown", onKey, true);
});
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
      class="grid gap-1.5 px-2.5 pt-1.5"
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
        <figcaption class="mt-1 flex h-5 items-center text-black/55">动画</figcaption>
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
              :src="photoSrc || spot.photo"
              alt="实拍"
              class="aspect-video w-full rounded-sm bg-[#f2f2f2] object-cover"
              :class="photoLoaded ? 'opacity-100' : 'opacity-0'"
              referrerpolicy="no-referrer"
              decoding="async"
              draggable="false"
              @load="photoLoaded = true"
              @error="onPhotoError"
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
          <span
            v-if="spot.photo && !photoFailed && photoLoaded && spot.takenAt"
            class="pointer-events-none absolute right-1 bottom-1 max-w-[calc(100%-8px)] truncate rounded-sm bg-black/50 px-1 py-0.5 text-[11px] leading-[14px] whitespace-nowrap text-white"
            :aria-label="`拍摄时间 ${spot.takenAt.slice(0, 10)}`"
          >
            {{ spot.takenAt.slice(0, 10) }}
          </span>
        </div>
        <figcaption class="mt-1 flex h-5 items-center text-black/55">
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
    <p
      v-if="spot.origin && spot.originURL"
      class="m-0 flex flex-wrap gap-x-2.5 px-2.5 pt-1.5 text-black/55"
    >
      <a :href="spot.originURL" target="_blank" rel="noopener" class="text-black/75 hover:underline"
        >截图来源：{{ spot.origin }}</a
      >
    </p>

    <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-2.5 pt-1 pb-1">
      <a
        v-if="hasAnitabiLink"
        :href="`https://www.anitabi.cn/map?bangumiId=${spot.bangumiId}&pid=${spot.anitabiPointId}`"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex min-h-9 items-center gap-1 whitespace-nowrap px-1 text-[#1864ab] no-underline hover:text-[#0f4c81] hover:underline focus-visible:underline"
      >
        在anitabi查看
        <svg
          class="h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
      </a>
      <a
        :href="googleMapsUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex min-h-9 items-center gap-1 whitespace-nowrap px-1 text-[#1864ab] no-underline hover:text-[#0f4c81] hover:underline focus-visible:underline"
      >
        在谷歌地图查看
        <svg
          class="h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
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
