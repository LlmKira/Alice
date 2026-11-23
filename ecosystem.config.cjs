// Alice 的 pm2 配置：用干净的库上线（不导入聊天历史，旧的 runtime/alice.db 原样不动）。
//
// 她的一切运行状态都在 runtime/live/（gitignore）：
//   live/alice.db            Journal（新库，首次启动时自动建表）
//   live/prompt-logs/        每轮提示日志（按天 JSONL：她看到的提示词和写出的原文）
//   live/spend/              按天的模型花费账（每次调用一行）
//   live/ops-control.json    暂停状态（重启后仍是暂停）
//   live/alice-errors.log    warn / error 日志
//   live/alice.lock          单实例锁
// Telegram 登录（mtcute session）仍是 runtime/alice.session（和以前同一个账号）。
//
// 首次上线（在仓库根目录跑；`!` 开头是在 Claude Code 里交互执行）：
//   1. runtime/.env 里加 ALICE_OPERATOR_ID（操作员的 Telegram 数字 id，必填），
//      可选 ALICE_DAILY_USD_CAP（每天模型花费上限，美元，默认 3）。
//   2. 登录（runtime/alice.session 已有且有效就跳过；pm2 在跑时先 pm2 stop alice-runtime）：
//        ! cd runtime && pnpm login
//      按提示输入 Telegram 发来的验证码（有两步验证再输密码），看到 "Logged in; session saved" 即可。
//   3. 带上她的贴纸（旧库只读打开、原样不动；只做一次）：
//        mkdir -p runtime/live && sqlite3 "file:runtime/alice.db?immutable=1" ".dump sticker_palette" | sqlite3 runtime/live/alice.db
//   4. 启动检查（新库上应看到 events: 0、stickers: 225、paused: false、Startup check passed）：
//        cd runtime && pnpm start:check
//   5. 看图标注服务（alice-tagger：本机 CPU，只听 127.0.0.1:39100，图片不出本机）：
//        bash services/tagger/setup.sh        建 Python 环境、下载约 470 MB 的模型（gitignore），只做一次
//      没装也能上线：她看图时只有描述，没有角色、尺度和"照片"。
//   6. pm2 start ecosystem.config.cjs（她和标注服务一起起），然后操作员会收到她私聊的"上线了"。
//
// 她已经在跑、后加标注服务时（ALICE_TAGGER_URL 是这里给 alice-runtime 的环境变量，要 --update-env 才生效）：
//   bash services/tagger/setup.sh
//   pm2 start ecosystem.config.cjs --only alice-tagger
//   curl -s 127.0.0.1:39100/health            应回 {"ok": true, ...}
//   pm2 restart ecosystem.config.cjs --only alice-runtime --update-env
//
// 日常：
//   pm2 logs alice-runtime            看日志（每 5 分钟一行 heartbeat）
//   curl -s 127.0.0.1:39100/health    标注服务在不在
//   pm2 stop alice-runtime            停（或操作员私聊她 /ops stop：干净退出，pm2 不会再拉起）
//   pm2 restart alice-runtime         重启
//   操作员私聊她：/ops status | pause | resume | cap <美元> | stop | help
//   北极星读数：cd runtime && pnpm northstar live/alice.db（开着轮换时加 --by-arm，按组分开）

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const runtimeDir = path.resolve(__dirname, "runtime");
const liveDir = path.join(runtimeDir, "live");
const taggerDir = path.resolve(__dirname, "services/tagger");
const TAGGER_PORT = "39100";

// 用 pnpm 管的那个 Node（better-sqlite3 是按它编译的）；系统的 /usr/bin/node 版本不同，打开库就崩。
const node = execFileSync("pnpm", ["-s", "exec", "node", "-p", "process.execPath"], {
  cwd: runtimeDir,
  encoding: "utf8",
}).trim();

module.exports = {
  apps: [
    {
      name: "alice-runtime",
      cwd: runtimeDir,
      script: node,
      args: "--import tsx --env-file=.env --env-file-if-exists=../.env.local src/index.ts",
      interpreter: "none",
      autorestart: true,
      // 退出码 0 是有意的停（/ops stop 或收到 SIGTERM）：不再拉起。崩溃是非 0，照常重启。
      stop_exit_codes: [0],
      restart_delay: 10000,
      max_restarts: 10,
      kill_timeout: 30000,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
        ALICE_PLATFORM: "telegram,qq",
        // 多平台注意力层级（ADR-300）：主体核心（记忆/心情/作息）跨平台共享，各平台各自独立节奏与 Top-1 竞争，避免单平台视角失真；可按需加 ALICE_PLATFORM_LAMBDA="qq=0.85" 微调单平台开口门槛
        ALICE_PLATFORM_ATTENTION: "per-platform",
        QQ_ONEBOT_WS_URL: "ws://127.0.0.1:3001",
        ALICE_STATE_DIR: liveDir,
        ALICE_DB_PATH: path.join(liveDir, "alice.db"),
        ALICE_TAGGER_URL: `http://127.0.0.1:${TAGGER_PORT}`,
        // 原生多工具对话层（ADR-298，2026-11-23 synthetic-charm 6:7 胜出且省 18.5%，real-v1 留出集验收通过）
        ALICE_SPEECH_FORMAT: "native",
        // 发言模型（ADR-281，方案 C）：全量发言走 google/gemini-4-hydrogen（无缓存双平台估约 $5/天），反思走 google/gemini-3.8-flash
        ALICE_SPEECH_MODEL: "google/gemini-4-hydrogen",
        // 后台反思模型（不直接对人出口，与发言模型拆分，单次 $0.002 vs neon $0.023）
        ALICE_PONDER_MODEL: "google/gemini-3.8-flash",
        // 每日花费上限（美元）：Telegram + QQ 双平台 + neon 发言，留足缓冲防半途自动暂停
        ALICE_DAILY_USD_CAP: "6",
        // 执行层领域配置（个人桌面空间 desk 等）
        ALICE_EXECUTOR_DOMAINS: path.join(liveDir, "domains.json"),
        // 线上语音：当前 ElevenLabs 为免费套餐（共享二次元音色 402 不可用），先用 MiniMax speech-2.8-hd + qiaopi_mengmei（俏皮萌妹）。
        TTS_PROVIDER: "minimax",
        // 线上轮换（PLAN 第 25 件）：2026-11-18 研究员定 loop-v2 整组进生产，关掉轮换，只跑生产。
        // 要再开，加 ALICE_ROTATE（sim/will-arms.ts 里的组名）和 ALICE_ROTATE_SEED；开了就别改种子。
        // 改完先 pnpm start:check；pm2 restart --update-env 不会删掉旧的环境变量，删变量要 pm2 delete 再 pm2 start。
      },
    },
    {
      // 看图标注（services/tagger/server.py）：WD v3 模型，常驻约 0.9 GB 内存，一张图约 0.7 秒、4 个线程。
      name: "alice-tagger",
      cwd: taggerDir,
      script: path.join(taggerDir, ".venv/bin/python"),
      args: "server.py",
      interpreter: "none",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 10,
      watch: false,
      time: true,
      env: { TAGGER_PORT, TAGGER_THREADS: "4" },
    },
  ],
};
