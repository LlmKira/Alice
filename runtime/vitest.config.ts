import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    // Fork workers outlive a killed parent (`vitest run | head` → SIGPIPE) and then
    // spin at 100% CPU growing ~80 MB/s each; threads die with the process.
    pool: "threads",
    // 同进程线程间共享已加载的纯模块图，避免 120+ 测试文件重复加载 eld/zod/mtcute（collect 283s -> ~25s）。
    isolate: false,
    // 原生模块留在主进程里，线程退出时不被卸载（见 setup/pin-native.ts）。
    globalSetup: ["test/setup/pin-native.ts"],
  },
});
