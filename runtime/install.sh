#!/bin/sh
# alice-install — Alice 一键安装
#
# 用法:
#   curl -fsSLO https://raw.githubusercontent.com/LlmKira/Alice/main/runtime/install.sh
#   less install.sh
#   sh install.sh
#
# 需要: Node.js 22+, pnpm, Go 1.22+ 或 Docker（Go/Docker 二选一用于编译 skill CLI）
#
# 安装位置:
#   /usr/local/bin/alice          # CLI
#   /usr/local/bin/hitokoto, ...  # skills
#   /usr/local/lib/alice/runtime/ # 运行时代码
#
# 工作目录（用户创建）:
#   /usr/local/lib/alice/runtime/.env      # 配置
#   /usr/local/lib/alice/runtime/alice.db  # 数据库

set -e

# ── 配置 ───────────────────────────────────────────────────────────

REPO="LlmKira/Alice"
BRANCH="main"
PREFIX="${ALICE_PREFIX:-/usr/local}"
WORKDIR="${TMPDIR:-/tmp}/alice-build-$$"

# ── 颜色 ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { printf "$GREEN▶$NC %s\n" "$1"; }
warn()  { printf "$YELLOW⚠$NC %s\n" "$1"; }
fail()  { printf "$RED✗$NC %s\n" "$1"; exit 1; }
step()  { printf "$BLUE▪$NC %s\n" "$1"; }

# ── 清理 ───────────────────────────────────────────────────────────

cleanup() {
    [ -d "$WORKDIR" ] && rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ── 检查运行时依赖（前置） ────────────────────────────────────────

info "检查运行时依赖..."

if ! command -v node >/dev/null 2>&1; then
    fail "Node.js 未安装（运行时必需）

安装方法:
  https://nodejs.org/
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
    fail "Node.js 版本过低 (v$(node -v))，需要 v22+"
fi
info "Node.js $(node -v) ✓"

if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
        info "使用 corepack 激活 pnpm..."
        corepack enable || fail "corepack enable 失败"
        corepack prepare pnpm@latest --activate || fail "pnpm 激活失败，请手动安装 pnpm"
    else
        info "安装 pnpm..."
        npm install -g pnpm || fail "pnpm 安装失败，请手动安装: npm install -g pnpm"
    fi
fi
info "pnpm $(pnpm --version) \u2713"

if ! command -v pm2 >/dev/null 2>&1; then
    info "安装 pm2..."
    npm install -g pm2 || fail "pm2 安装失败，请手动安装: npm install -g pm2"
fi
info "pm2 $(pm2 --version) ✓"

# ── 检查编译依赖 ───────────────────────────────────────────────────

info "检查编译依赖..."

BUILD_METHOD=""

if command -v go >/dev/null 2>&1; then
    GO_VERSION=$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1)
    MAJOR=$(echo "$GO_VERSION" | cut -d. -f1 | tr -d 'go')
    MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

    if [ "$MAJOR" -gt 1 ] || { [ "$MAJOR" -eq 1 ] && [ "$MINOR" -ge 22 ]; }; then
        info "使用 Go $GO_VERSION"
        BUILD_METHOD="go"
    else
        warn "Go 版本过低 ($GO_VERSION)，需要 1.22+"
    fi
fi

if [ -z "$BUILD_METHOD" ] && command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        warn "使用 Docker 编译（未检测到 Go 1.22+）"
        BUILD_METHOD="docker"
    fi
fi

if [ -z "$BUILD_METHOD" ]; then
    fail "需要 Go 1.22+ 或 Docker

安装方法:
  Go: curl -fsSL https://go.dev/dl/go1.22.linux-amd64.tar.gz | sudo tar -C /usr/local -xzf -
      export PATH=\$PATH:/usr/local/go/bin

  Docker: https://docs.docker.com/get-docker/"
fi

# ── 克隆仓库 ───────────────────────────────────────────────────────

info "克隆仓库..."
mkdir -p "$WORKDIR"

if command -v git >/dev/null 2>&1; then
    step "git clone --depth 1 https://github.com/$REPO"
    git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO" "$WORKDIR/alice" 2>&1 | while read line; do step "$line"; done
else
    step "下载压缩包..."
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xzf - -C "$WORKDIR"
    mv "$WORKDIR/Alice-$BRANCH" "$WORKDIR/alice"
fi

cd "$WORKDIR/alice/runtime"

# ── 编译 ────────────────────────────────────────────────────────────

info "编译..."

step "安装 pnpm 依赖（用于构建 system-bin）"
cd "$WORKDIR/alice"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
cd "$WORKDIR/alice/runtime"

step "构建 system-bin（irc / self / alice-pkg）"
pnpm run build:bin

case "$BUILD_METHOD" in
    go)
        step "使用本地 Go"
        mkdir -p dist/bin

        step "编译 alice CLI"
        CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/alice ./cmd/alice

        for skill in cmd/skills/*/; do
            name=$(basename "$skill")
            step "编译 $name"
            CGO_ENABLED=0 go build -ldflags="-s -w" -o "dist/bin/$name" "./$skill"
        done
        ;;

    docker)
        step "使用 Docker"
        mkdir -p dist/bin

        docker run --rm \
            -v "$(pwd):/workspace" \
            -w /workspace \
            --network host \
            golang:1.22-alpine \
            sh -c '
                apk add --no-cache git ca-certificates
                mkdir -p dist/bin
                CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/alice ./cmd/alice
                for skill in cmd/skills/*/; do
                    name=$(basename $skill)
                    CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/$name ./$skill
                done
            '
        ;;
esac

for bin in irc self alice-pkg; do
    if [ ! -x "dist/bin/$bin" ]; then
        fail "缺少 system-bin: dist/bin/$bin（请检查 pnpm run build:bin）"
    fi
done

COUNT=$(ls dist/bin/ | wc -l)
info "编译完成: $COUNT 个二进制"

# ── 安装 ────────────────────────────────────────────────────────────

info "安装到 $PREFIX ..."

# 安装二进制
sudo mkdir -p "$PREFIX/bin"
for bin in dist/bin/*; do
    name=$(basename "$bin")
    step "安装 $name"
    sudo install -m 755 "$bin" "$PREFIX/bin/$name"
done

# 安装运行时代码
info "安装运行时代码..."
sudo mkdir -p "$PREFIX/lib/alice/runtime"

# 复制必要的运行时文件
for item in .env.example config.toml SOUL.md src package.json tsconfig.json drizzle.config.ts drizzle skills dist; do
    if [ -e "$item" ]; then
        step "复制 $item"
        sudo cp -r "$item" "$PREFIX/lib/alice/runtime/"
    fi
done

# 复制 pnpm workspace 文件（锁文件和构建白名单在仓库根目录）
sudo cp "$WORKDIR/alice/package.json" "$PREFIX/lib/alice/"
sudo cp "$WORKDIR/alice/pnpm-lock.yaml" "$PREFIX/lib/alice/"
sudo cp "$WORKDIR/alice/pnpm-workspace.yaml" "$PREFIX/lib/alice/"
sudo cp "$WORKDIR/alice/ecosystem.config.cjs" "$PREFIX/lib/alice/"

# 安装依赖
info "安装运行时依赖..."
cd "$PREFIX/lib/alice"
sudo pnpm install --prod --frozen-lockfile 2>/dev/null || sudo pnpm install --prod

# 验证原生模块（better-sqlite3 / @mtcute/node）
info "验证原生模块..."
if ! sudo sh -c "cd '$PREFIX/lib/alice/runtime' && node --input-type=module -e \"await import('better-sqlite3'); await import('@mtcute/node');\""; then
    fail "原生模块加载失败（better-sqlite3 / @mtcute/node）。

可能原因:
  1. pnpm 跳过了构建脚本（缺少根 package.json 的 onlyBuiltDependencies）
  2. 当前系统缺少 Node.js 对应的预编译产物
  3. 上一次安装残留了不完整的 node_modules

建议处理:
  sudo pnpm --dir $PREFIX/lib/alice rebuild better-sqlite3
  然后重新执行安装脚本"
fi

# ── 构建 Docker 镜像（可选） ──────────────────────────────────────────

cd "$WORKDIR/alice/runtime"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    info "构建 Docker 镜像（skill 隔离执行环境）..."
    if ! docker image inspect alice-skill-runner:bookworm >/dev/null 2>&1; then
        step "构建 alice-skill-runner:bookworm"
        docker build -t alice-skill-runner:bookworm -f Dockerfile.skill-runner . 2>&1 | while read line; do step "$line"; done
    else
        step "镜像已存在，跳过构建"
    fi
else
    warn "Docker 未安装或未运行，跳过 skill-runner 镜像构建"
    warn "如需 skill 沙箱隔离，请安装 Docker: https://docs.docker.com/get-docker/"
fi

info "✅ 安装完成!"
echo ""
echo "下一步:"
echo "  1. cd $PREFIX/lib/alice"
echo "  2. sudo cp runtime/.env.example runtime/.env"
echo "  3. sudo vim runtime/.env"
echo "  4. alice doctor"
echo "  5. pm2 start ecosystem.config.cjs && pm2 save"
echo ""
echo "多实例:"
echo "  复制仓库到另一个目录，修改 runtime/.env 后用 pm2 start ecosystem.config.cjs --name alice-bot2"
echo ""
