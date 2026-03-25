import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: {
    main: "src/main/index.ts",
    preload: "src/preload/index.ts",
    "browser-view-preload": "src/preload/browser-view.ts"
  },
  external: ["electron"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  outDir: "dist",
  splitting: false
});
