import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

// https://viteplus.dev/guide/
export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [vue(), UnoCSS()]),
  // maplibre-gl 本身体积大，单独成块且无法再拆，放宽告警阈值
  build: { chunkSizeWarningLimit: 2000 },
});
