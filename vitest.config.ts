import { fileURLToPath } from "node:url";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { budgetFor, MODELLED_HOOK_SPAWNS, SCRIPT_TEST_TIMEOUT_MS } from "./test/slow-machine";

/**
 * 試験を 3 つに分ける。**分ける理由は「外に何を要求するか」**である。
 *
 * `bin/` と `loop/` の試験は、シェルスクリプトを実際に起こして終了コードを見る。
 * 1 件で `test/slow-machine.ts` の `MODELLED_SPAWNS` ぶん起こすものがあり、
 * **既定の 5 秒はこの機械の実測の内側にある**
 * （#131。落ちる試験が走るたびに変わっていた）。
 *
 * **枠を全体へ伸ばさない。** 起こさない側まで伸ばすと、**本物の無限ループの検出が
 * 遅れるだけ**になる。伸ばす理由が無いところは既定のままにしておく。
 *
 * `db` は**動いている Supabase を要求する**。**`./task check` から外す**のは、
 * **worker が 1 周ごとに叩くもの**だからで、**そこへスタックの起動を足すと、
 * 起きていないだけで赤になる**——**「落ちた」と「まだ起きていない」が混ざる。**
 * **走らせるのは `./task test:db` と CI の専用 job**である (#210)。
 */
export const DB_TEST_PATTERN = "**/*.db.test.ts";

export const projects = [
  {
    test: {
      name: "unit",
      environment: "node",
      // UI コンポーネントのテストを書くときに jsdom の project を足す。
      // それまでは node で足りるので増やさない。
      //
      // **直下も見る** (#493)。**`AGENTS.md` は repo 直下**なので、**co-location で
      // 並ぶ試験もそこに置く**——**include に足さないと、置いただけで走らない。**
      //
      // **`supabase/` も見る** (#561)。**`config.toml` を見張る試験はその隣に置く**
      // ——**ここへ足さないと、置いただけで走らない**（直下と同じ理由）。
      include: ["*.test.ts", "src/**/*.test.ts", "test/**/*.test.ts", "supabase/**/*.test.ts"],
      // **上の include は `*.db.test.ts` にも当たる。** 除かないと、
      // **DB を要求する試験が `./task check` に混ざる。**
      exclude: [DB_TEST_PATTERN],
    },
  },
  {
    test: {
      name: "scripts",
      environment: "node",
      // bin/ のループ用スクリプトもテストする。ここが壊れるとループが空転し続ける。
      include: ["bin/**/*.test.ts", "loop/**/*.test.ts"],
      exclude: [DB_TEST_PATTERN],
      testTimeout: SCRIPT_TEST_TIMEOUT_MS,
      // **本体だけ伸ばしても、本体へ到達する前に落ちる。** hook は別枠である。
      hookTimeout: budgetFor(MODELLED_HOOK_SPAWNS),
      // 落ちたときに、負荷が原因かどうかを出力から判別できるようにする。
      setupFiles: ["./test/slow-machine-setup.ts"],
    },
  },
  {
    test: {
      name: "db",
      environment: "node",
      include: [DB_TEST_PATTERN],
      // **同じ行を 2 本が書き換える形**を試すので、**起動と後片付けを含めて
      // 既定の 5 秒には収まらない。**
      testTimeout: SCRIPT_TEST_TIMEOUT_MS,
      hookTimeout: budgetFor(MODELLED_HOOK_SPAWNS),
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
