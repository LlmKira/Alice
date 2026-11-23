import { createRequire } from "node:module";

/**
 * 在 vitest 主进程里先加载一次原生模块，让它们在整个运行期间都留在内存里。
 * 不这样做的话，测试线程退出时会卸载线程里加载的 .node，V8 随后清理线程时去调它登记的回收函数，
 * 地址已经失效，整个进程段错误（约一半的整套运行会崩）。
 */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as new (path: string) => { close: () => void };
  new Database(":memory:").close();
  require("ntgcalls");
}
