# Alice Runtime

以 Telegram userbot 为身体、以压力场为神经系统、以 LLM 为大脑的自主实体。

> 本项目的 Node.js 工作流统一使用 `pnpm`，不使用 Bun。

## 部署前检查

推荐的最小环境：

| 依赖 | 作用 | 必需 |
|------|------|------|
| Node.js 22+ | 运行时、system-bin CLI | ✅ |
| pnpm | 安装依赖、构建 system-bin | ✅ |
| Go 1.22+ 或 Docker | 编译 `alice` CLI 与 Go skill | 安装时 |
| SQLite | 本地数据库 | ✅ |
| Docker | skill 沙箱执行 | ✅ |

运行配置在 `runtime/config.toml`。这个文件只放非敏感配置，可以提交和发布。

`.env` 只放 secret。首次登录至少需要这些字段：

```bash
TELEGRAM_API_HASH=abcdef123456
TELEGRAM_PHONE=+8613800138000
TELEGRAM_ADMIN=123456789

LLM_API_KEY=sk-xxx
```

## 焦点白名单

如果你希望 Alice 只在少数几个聊天里分配注意力，推荐直接写在 `runtime/config.toml`：

```toml
[focus]
whitelist = [
  "-1001234567890",
  "7785440246",
]
```

这里建议直接写 Telegram chat ID，不需要写内部的 `channel:` 前缀。运行时会自动归一化。

行为边界：

- 白名单只限制“待选目标”
- 压力场仍然对全量图正常计算
- 修改 TOML 后需要重启 Alice 生效

## QQ / OneBot 接入

QQ 第一接入路线使用 OneBot v11 + NapCatQQ。部署、配置和最小验证见 [deploy/qq-onebot.md](./deploy/qq-onebot.md)。

## 方式一：一键安装

这是最省事的路径。安装脚本现在会同时完成：

1. 编译 Go 二进制
2. 执行 `pnpm run build:bin` 生成 `irc` / `self` / `alice-pkg`
3. 把 `runtime/dist/` 一起安装到 `/usr/local/lib/alice/runtime`

```bash
curl -fsSL https://raw.githubusercontent.com/LlmKira/Alice/main/runtime/install.sh | sh

mkdir -p ~/alice
cd ~/alice

alice init
$EDITOR .env
alice doctor
alice run
```

如果你希望后台运行：

```bash
alice start
alice status
tail -f logs/$(date +%F).log
```

## 方式二：源码部署

适合需要自己改代码、接 systemd、或排查安装问题的场景。

### 1. 安装依赖

在仓库根目录执行：

```bash
git clone https://github.com/LlmKira/Alice.git alice-telegram-bot
cd alice-telegram-bot
pnpm install --frozen-lockfile
```

### 2. 构建必需产物

`alice` 运行时除了 Go 二进制，还依赖 system-bin。很多 “`irc` 没有编译” 的报错，根因就是这一步没做。

```bash
cd runtime

# 生成 irc / self / alice-pkg
pnpm run build:bin

# 编译 alice CLI 和 Go skill
mkdir -p dist/bin
CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/alice ./cmd/alice
for skill in cmd/skills/*/; do
  name=$(basename "$skill")
  CGO_ENABLED=0 go build -ldflags="-s -w" -o "dist/bin/$name" "./$skill"
done
```

### 3. 本地验证产物

```bash
test -x dist/bin/alice
test -x dist/bin/irc
test -x dist/bin/self
test -x dist/bin/alice-pkg
```

这四个检查里只要有一个失败，先不要启动运行时。

### 4. 运行

源码运行推荐显式指定 `ALICE_RUNTIME_DIR`，避免 CLI 在多目录场景里猜错。

```bash
mkdir -p ~/alice
cd ~/alice

ALICE_RUNTIME_DIR=/path/to/alice-telegram-bot/runtime /path/to/alice-telegram-bot/runtime/dist/bin/alice init
$EDITOR .env
ALICE_RUNTIME_DIR=/path/to/alice-telegram-bot/runtime /path/to/alice-telegram-bot/runtime/dist/bin/alice doctor
ALICE_RUNTIME_DIR=/path/to/alice-telegram-bot/runtime /path/to/alice-telegram-bot/runtime/dist/bin/alice run
```

## 验证清单

无论你是脚本安装还是源码部署，启动前至少做这几步：

```bash
alice doctor
```

`alice doctor` 通过后，重点看这几项：

- `Node.js` 是否为 `v22+`
- `Runtime` 是否指向正确的 `runtime/`
- `System bin` 是否存在，并且不缺 `irc`, `self`, `alice-pkg`
- `Native modules` 是否能加载 `better-sqlite3` 和 `@mtcute/node`
- `.env` 是否已经填写 `TELEGRAM_PHONE` 与 `LLM_API_KEY`

脚本安装完成后，还可以直接检查安装目录：

```bash
test -x /usr/local/lib/alice/runtime/dist/bin/irc
test -x /usr/local/lib/alice/runtime/dist/bin/self
test -x /usr/local/lib/alice/runtime/dist/bin/alice-pkg
```

## 常见问题

### 1. `irc: not found` / `alice doctor` 提示缺少 system-bin

这是最常见的部署坑。说明 `runtime/dist/bin/irc` 没生成，或者生成了但没被复制到安装目录。

源码部署修复：

```bash
cd /path/to/alice-telegram-bot
pnpm install --frozen-lockfile
cd runtime
pnpm run build:bin
test -x dist/bin/irc
```

脚本安装修复：

```bash
curl -fsSL https://raw.githubusercontent.com/LlmKira/Alice/main/runtime/install.sh | sh
test -x /usr/local/lib/alice/runtime/dist/bin/irc
```

### 2. `better-sqlite3` 或 `@mtcute/node` 加载失败

先用 `alice doctor` 确认是不是原生模块问题，再重建原生依赖。

源码部署：

```bash
cd /path/to/alice-telegram-bot
pnpm rebuild better-sqlite3 @mtcute/node
```

脚本安装：

```bash
sudo pnpm --dir /usr/local/lib/alice rebuild better-sqlite3 @mtcute/node
```

如果还是失败，通常是 Node.js 版本不匹配，或者当前系统没有对应的预编译产物。

### 3. `.env` 里填了 `OPENAI_*`，但 `alice doctor` 仍然报错

Alice 的非敏感配置读取 `runtime/config.toml`，`.env` 只提供 TOML 中 `*_env` 引用的 secret。把 key 放到：

```bash
LLM_API_KEY=...
```

模型名、base URL、模型池写在 `runtime/config.toml` 的 `[[providers]]` 里。

### 4. 启动时报 Telegram 登录相关错误

请确认：

- `TELEGRAM_PHONE` 已填写，且带国家区号，例如 `+8613800138000`
- `runtime/config.toml` 里的 `telegram.api_id` 是数字
- `TELEGRAM_API_HASH` 不是 bot token

### 5. 需要手动跑数据库迁移吗？

不需要。Alice 首次启动时会自动执行迁移。

## 多实例

每个工作目录是一个独立实例：

```bash
mkdir ~/bot1 && cd ~/bot1 && alice init && alice start
mkdir ~/bot2 && cd ~/bot2 && alice init && alice start
```

## systemd

如果你要走系统服务部署，先看 [deploy/systemd/README.md](./deploy/systemd/README.md)。那份文档包含了：

- 运行用户创建
- `pnpm` 安装位置
- `pnpm run build:bin` 的时机
- service 启动前的验证命令

## 目录结构

```text
~/alice/
├── .env
├── .alice.pid
├── alice.db
├── alice-errors.log
└── logs/
    └── 2026-04-05.log
```

## 文档

- [愿景](../docs/adr/00-vision.md)
- [架构概览](../docs/adr/02-architecture-overview.md)
- [理论基础](../docs/adr/01-theoretical-foundations.md)

## License

MIT
