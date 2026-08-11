import { describe, expect, it } from "vitest";
import { config, projects } from "../vitest.config";
import { budgetFor, loadNote, MODELLED_SPAWNS, SCRIPT_TEST_TIMEOUT_MS } from "./slow-machine";

describe("落ちたときに、負荷が原因だと分かる", () => {
  // **これが無いと、負荷で落ちたことを外から判別できない。**
  // 実測（#131）では、落ちる試験が走るたびに変わり、**表明の破れまで混ざった**——
  // `expected … to contain` は**普通なら本物の不具合の顔**をしている。
  // 「同じ試験が同じ形で落ちたら本物」という判定は、そのせいで成り立たなかった。

  const base = { name: "3 周続くと loop/STOP が配られる", durationMs: 5000, timeoutMs: 5000 };

  it("CPU 数に見合う負荷なら、何も言わない", () => {
    // **負荷のせいにしない。** 空いている機械で落ちたなら、それは本物である
    expect(loadNote({ ...base, load1: 0.8, cpus: 1 })).toBeNull();
    expect(loadNote({ ...base, load1: 3.5, cpus: 4 })).toBeNull();
  });

  it("CPU 数を超える負荷なら、実測値を添えて言う", () => {
    const note = loadNote({ ...base, load1: 34.0, cpus: 1 });

    expect(note).not.toBeNull();
    expect(note).toContain("34");
    expect(note).toContain("1");
  });

  it("枠に届かなかったこと（時間切れ）が分かる", () => {
    const note = loadNote({ ...base, durationMs: 5001, timeoutMs: 5000, load1: 34, cpus: 1 });

    expect(note).toContain("時間切れ");
  });

  it("時間切れでなくても言う（表明の破れが混ざる）", () => {
    // **ここがこの Issue の核心。** timeout だけを対象にすると、
    // **負荷で壊れた表明を本物の不具合として追いかける**
    const note = loadNote({ ...base, durationMs: 120, timeoutMs: 5000, load1: 34, cpus: 1 });

    expect(note).not.toBeNull();
    expect(note).not.toContain("時間切れ");
  });

  it("確かめ方まで書く", () => {
    // **「負荷かもしれない」だけでは、次に何をすればよいか決まらない。**
    // 単独で走らせ直して再現するかどうかが、唯一の切り分けである
    expect(loadNote({ ...base, load1: 34, cpus: 1 })).toContain("単独");
  });

  it("どの試験が落ちたかを含める", () => {
    // 並んだ出力の中から、この注記がどれに付いたのか分かるようにする
    expect(loadNote({ ...base, load1: 34, cpus: 1 })).toContain(base.name);
  });
});

describe("プロセスを起こす試験の枠", () => {
  const named = (name: string) => projects.find((project) => project.test.name === name);

  it("その一覧が、実際に vitest へ渡っている", () => {
    // **「書いてある」と「渡っている」は別である。** 別の場所に一覧を作っても、
    // config が読んでいなければ枠は効かない
    expect(config.test?.projects).toBe(projects);
  });

  it("bin/ と loop/ の試験は、実測から導いた枠で走る", () => {
    // **既定の 5 秒はこの機械の実測の内側にある。** いちばん重い試験は
    // git と loop-stall を 10 回起こし、1 回あたり 0.22〜1.00 秒かかる（実測）。
    // **枠は「数えた回数 × 実測の最悪値 × 安全率」で決める**——
    // 伸ばすのではなく、**何回起こすかから導く**
    const scripts = named("scripts");

    expect(scripts?.test.include).toEqual(["bin/**/*.test.ts", "loop/**/*.test.ts"]);
    expect(scripts?.test.testTimeout).toBe(SCRIPT_TEST_TIMEOUT_MS);
  });

  it("プロセスを起こさない試験の枠は伸ばさない", () => {
    // **要らないところまで伸ばすと、本物の無限ループの検出が遅れるだけ**になる。
    // 伸ばす理由は「プロセスを起こすこと」なので、起こさない側は既定のまま
    const unit = named("unit");

    expect(unit?.test.include).toEqual(["src/**/*.test.ts", "test/**/*.test.ts"]);
    expect(unit?.test.testTimeout).toBeUndefined();
  });

  it("負荷の注記は、プロセスを起こす側に配線されている", () => {
    // **落ちるのはそちら**なので、注記が要るのもそちらである
    expect(named("scripts")?.test.setupFiles).toContain("./test/slow-machine-setup.ts");
  });

  it("枠は起こす回数に比例する", () => {
    // **これが「伸ばした値ではなく導いた値」の中身である。**
    // 定数を書き写して大小を見るだけだと、**数え違いも直したあとも同じように通る**
    expect(budgetFor(2)).toBe(budgetFor(1) * 2);
    expect(SCRIPT_TEST_TIMEOUT_MS).toBe(budgetFor(MODELLED_SPAWNS));
  });

  it("見積もりが実際と合っているかは、起こす側が確かめる", () => {
    // **ここからは steps の中身が見えない。** 数え違いは
    // `bin/loop-stall.test.ts` の `runNoWorkToLimit` が自分の回数を数えて落とす
    // （実際に 9 と数えていて、10 で赤になった）。
    // **この試験は「回数が 1 以上の整数である」ことだけを見る**
    expect(Number.isInteger(MODELLED_SPAWNS)).toBe(true);
    expect(MODELLED_SPAWNS).toBeGreaterThan(0);
  });
});
