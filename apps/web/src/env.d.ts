/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /**
   * MapLibre 样式 URL。
   * 不设置时用 OpenFreeMap Liberty：https://tiles.openfreemap.org/styles/liberty
   */
  readonly VITE_MAP_STYLE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
