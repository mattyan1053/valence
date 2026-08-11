import { fileURLToPath } from "node:url";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { budgetFor, MODELLED_HOOK_SPAWNS, SCRIPT_TEST_TIMEOUT_MS } from "./test/slow-machine";

/**
 * 試験を 2 つに分ける。**分ける理由は「プロセスを起こすかどうか」**である。
 *
 * `bin/` と `loop/` の試験は、シェルスクリプトを実際に起こして終了コードを見る。
 * 1 件で 9 プロセス起こすものがあり、**既定の 5 秒はこの機械の実測の内側にある**
 * （#131。落ちる試験が走るたびに変わっていた）。
 *
 * **枠を全体へ伸ばさない。** 起こさない側まで伸ばすと、**本物の無限ループの検出が
 * 遅れるだけ**になる。伸ばす理由が無いところは既定のままにしておく。
 */
export const projects = [
  {
    test: {
      name: "unit",
      environment: "node",
      // UI コンポーネントのテストを書くときに jsdom の project を足す。
      // それまでは node で足りるので増やさない。
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "scripts",
      environment: "node",
      // bin/ のループ用スクリプトもテストする。ここが壊れるとループが空転し続ける。
      include: ["bin/**/*.test.ts", "loop/**/*.test.ts"],
      testTimeout: SCRIPT_TEST_TIMEOUT_MS,
      // **本体だけ伸ばしても、本体へ到達する前に落ちる。** hook は別枠である。
      hookTimeout: budgetFor(MODELLED_HOOK_SPAWNS),
      // 落ちたときに、負荷が原因かどうかを出力から判別できるようにする。
      setupFiles: ["./test/slow-machine-setup.ts"],
    },
  },
] satisfies ViteUserConfig[];

export const config: ViteUserConfig = {
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects,
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
};

export default defineConfig(config);
