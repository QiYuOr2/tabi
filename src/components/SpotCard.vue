<script setup lang="ts">
import type { Spot } from "../types/spot";

defineProps<{ spot: Spot; color: string }>();
defineEmits<{ close: [] }>();

const SOURCE_LABEL: Record<Spot["source"], string> = {
  exif: "照片 EXIF",
  anitabi: "anitabi 匹配",
  geocode: "地理编码",
  manual: "手动标注",
};
</script>

<template>
  <article
    class="absolute z-10 left-3 right-3 bottom-3 sm:left-auto sm:right-4 sm:top-4 sm:bottom-auto sm:w-96 max-h-[80vh] overflow-auto rounded-xl bg-white/95 shadow-xl backdrop-blur text-gray-800"
  >
    <header class="flex items-start gap-2 p-4 pb-2">
      <span class="mt-1.5 h-3 w-3 shrink-0 rounded-full" :style="{ background: color }" />
      <div class="min-w-0 flex-1">
        <p class="text-xs text-gray-500">{{ spot.animeName }}</p>
        <h2 class="text-base font-semibold leading-snug">{{ spot.pointName }}</h2>
      </div>
      <button
        class="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        aria-label="关闭"
        @click="$emit('close')"
      >
        ✕
      </button>
    </header>

    <div class="grid grid-cols-2 gap-2 px-4">
      <figure class="m-0">
        <img
          v-if="spot.animeImage"
          :src="spot.animeImage"
          alt="动画截图"
          class="aspect-video w-full rounded object-cover bg-gray-100"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <div
          v-else
          class="aspect-video w-full rounded bg-gray-100 grid place-items-center text-xs text-gray-400"
        >
          暂无截图
        </div>
        <figcaption class="mt-1 text-xs text-gray-500">动画</figcaption>
      </figure>
      <figure class="m-0">
        <img
          v-if="spot.photo"
          :src="spot.photo"
          alt="实拍"
          class="aspect-video w-full rounded object-cover bg-gray-100"
          loading="lazy"
        />
        <div
          v-else
          class="aspect-video w-full rounded bg-gray-100 grid place-items-center text-xs text-gray-400"
        >
          暂无实拍
        </div>
        <figcaption class="mt-1 text-xs text-gray-500">实拍</figcaption>
      </figure>
    </div>

    <div v-if="spot.anitabiPointId && spot.bangumiId != null" class="px-4 pt-3">
      <a
        :href="`https://www.anitabi.cn/map?bangumiId=${spot.bangumiId}&pid=${spot.anitabiPointId}`"
        target="_blank"
        rel="noopener"
        class="inline-flex rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
      >
        在 anitabi 查看此地标
      </a>
    </div>

    <footer class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-xs text-gray-500">
      <span>坐标：{{ SOURCE_LABEL[spot.source] }}</span>
      <span v-if="spot.takenAt">拍摄：{{ spot.takenAt.slice(0, 10) }}</span>
      <a
        v-if="spot.origin && spot.originURL"
        :href="spot.originURL"
        target="_blank"
        rel="noopener"
        class="text-blue-600 hover:underline"
        >截图来源：{{ spot.origin }}</a
      >
      <a
        v-if="spot.bangumiId"
        :href="`https://anitabi.cn/map?bangumiId=${spot.bangumiId}`"
        target="_blank"
        rel="noopener"
        class="text-blue-600 hover:underline"
        >anitabi</a
      >
      <span v-if="spot.example" class="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700"
        >示例数据</span
      >
    </footer>
  </article>
</template>
