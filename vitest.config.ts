import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // UI コンポーネントのテストを書くときに jsdom の project を足す。
    // それまでは node で足りるので増やさない。
    environment: "node",
    // bin/ のループ用スクリプトもテストする。ここが壊れるとループが空転し続ける。
    include: ["src/**/*.test.ts", "bin/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 内側のレイヤだけを対象にする。app/ui は E2E で担保する方針。
      include: ["src/domain/**", "src/application/**"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
