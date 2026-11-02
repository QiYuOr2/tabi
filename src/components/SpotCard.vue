<script setup lang="ts">
import { ref } from "vue";
import type { Spot } from "../types/spot";

defineProps<{ spot: Spot; color: string; onClose: () => void }>();

const animeFailed = ref(false);
const photoFailed = ref(false);

const SOURCE_LABEL: Record<Spot["source"], string> = {
  exif: "照片 EXIF",
  anitabi: "anitabi 匹配",
  geocode: "地理编码",
  manual: "手动标注",
};
</script>

<template>
  <article class="relative text-xs leading-5 text-[#333]">
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

    <div class="grid grid-cols-2 gap-1 px-2.5 pt-1.5">
      <figure class="m-0">
        <img
          v-if="spot.animeImage && !animeFailed"
          :src="spot.animeImage"
          alt="动画截图"
          class="aspect-video w-full rounded-sm bg-[#f2f2f2] object-cover"
          referrerpolicy="no-referrer"
          @error="animeFailed = true"
        />
        <div
          v-else
          class="grid aspect-video w-full place-items-center rounded-sm bg-[#f2f2f2] text-black/40"
        >
          {{ spot.animeImage ? "图片加载失败" : "暂无截图" }}
        </div>
        <figcaption class="mt-0.5 text-black/55">动画</figcaption>
      </figure>
      <figure class="m-0">
        <img
          v-if="spot.photo && !photoFailed"
          :src="spot.photo"
          alt="实拍"
          class="aspect-video w-full rounded-sm bg-[#f2f2f2] object-cover"
          referrerpolicy="no-referrer"
          @error="photoFailed = true"
        />
        <div
          v-else
          class="grid aspect-video w-full place-items-center rounded-sm bg-[#f2f2f2] text-black/40"
        >
          {{ spot.photo ? "图片加载失败" : "暂无实拍" }}
        </div>
        <figcaption class="mt-0.5 text-black/55">实拍</figcaption>
      </figure>
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
