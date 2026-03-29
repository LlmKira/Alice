# Deployment Guide

> **New to this?** Just run `bash setup.sh` from the project root — it handles everything interactively. This guide is the manual walkthrough for those who want full control.

---

## Prerequisites

Before you start, make sure you have:

| Tool | Install |
|------|---------|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) |
| **pnpm** | `npm install -g pnpm` |
| **pm2** | `npm install -g pm2` |

That's all you need for the core runtime. Auxiliary services (image tagging, voice synthesis) are optional and covered later.

---

## Step 1 — Clone

```bash
git clone --recurse-submodules https://github.com/LlmKira/alice.git
cd alice
```

---

## Step 2 — Get Telegram API Credentials

Alice runs as a **userbot** on your own Telegram account (not a bot). You need API credentials from Telegram:

1. Go to **[https://my.telegram.org/apps](https://my.telegram.org/apps)**
2. Log in with your phone number
3. Create a new app (any name)
4. Copy your **API ID** (a number) and **API Hash** (a long string)

---

## Step 3 — Get an LLM API Key

Alice needs an OpenAI-compatible LLM endpoint. The easiest option for Chinese users:

**[OhMyGPT](https://www.ohmygpt.com)** — 200+ models, no VPN required, works out of the box.

Other options: OpenRouter, DeepSeek, OpenAI, Google AI Studio, or a local Ollama instance.

You need three things: **base URL**, **API key**, and **model name**.

---

## Step 4 — Configure

```bash
cd runtime
cp .env.example .env
nano .env   # or any text editor
```

Fill in the six required lines:

```bash
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_PHONE=+8613800138000

LLM_BASE_URL=https://api.ohmygpt.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gemini-2.5-flash-preview-05-20
```

Everything else in `.env.example` is optional — vision, TTS, music, etc. Leave them commented out to start.

---

## Step 5 — Install & First Login

```bash
cd runtime
pnpm install
pnpm run dev
```

> **Do not run `pnpm run db:migrate` separately.** Alice auto-migrates on startup using a custom SQLite extension. Running drizzle-kit directly will fail.

On first run, Alice prompts you to log in to Telegram:

1. Enter the verification code Telegram sends to your app
2. Enter your 2FA password if you have one set

After login, a session file is saved. You won't need to log in again.

Press `Ctrl+C` once you see Alice start ticking (you'll see log output like `[engine] tick 1`).

---

## Step 6 — Production (pm2)

```bash
# From project root (not runtime/)
pm2 startOrRestart ecosystem.config.cjs --only alice-runtime
pm2 logs alice-runtime --lines 30
```

Alice is now running in the background and will survive reboots if you run:

```bash
pm2 startup   # follow the printed instruction
pm2 save
```

### Useful commands

```bash
pm2 status                     # see all running processes
pm2 logs alice-runtime         # tail logs
pm2 restart alice-runtime      # restart after code changes
pm2 stop alice-runtime         # pause
```

---

## Step 7 — Verify

```bash
# Recent ticks (pressure values should grow over time)
sqlite3 runtime/alice.db "SELECT tick, p1, p2, p3, p4, p5, p6, api FROM tick_log ORDER BY tick DESC LIMIT 5;"

# Recent actions (Alice speaking, reacting, forwarding)
sqlite3 runtime/alice.db "SELECT tick, voice, action_type, chat_id FROM action_log ORDER BY tick DESC LIMIT 5;"
```

If you see tick entries — Alice is alive. If you see action entries — she's already doing things.

---

## Optional Features

Enable these by setting the relevant env vars in `runtime/.env`:

| Feature | Env Var(s) | What it enables |
|---------|-----------|----------------|
| **Vision** | `VISION_MODEL=gemini-2.0-flash-lite` | Alice sees photos, stickers, media |
| **Voice (TTS)** | `TTS_BASE_URL`, `TTS_API_KEY` | Alice sends voice messages (MiniMax recommended) |
| **Web Search** | `EXA_API_KEY` | Alice searches the web |
| **Music** | `MUSIC_API_BASE_URL` | Alice recommends and searches music |
| **LLM Fallback** | `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY` | Auto-switch to backup model on failure |

---

## Optional: Auxiliary Services (Image Tagging)

WD-Tagger and Anime-Classify improve image understanding. They're optional — Alice degrades gracefully without them.

```bash
# WD14 Tagger
cd services/wd14-tagger-server
pip install pdm && pdm install

# Anime Classifier
cd services/anime-classify
pip install uv && uv sync
```

Then start everything together:

```bash
pm2 startOrRestart ecosystem.config.cjs   # starts all three services
```

---

## Optional: Skill Sandbox (Docker)

For isolated skill execution (weather, music, search apps):

```bash
cd runtime
docker build -t alice-skill-runner:bookworm -f Dockerfile.skill-runner .
```

For production hardening with [gVisor](https://gvisor.dev/):

```bash
bash runtime/scripts/install-runsc.sh
# then set SKILL_BACKEND=sandboxed in .env
```

Without Docker, Alice falls back to direct shell execution automatically.

---

## Optional: systemd (Server Hardening)

For a production server with security restrictions:

```bash
sudo useradd --system --home /var/lib/alice-runtime --shell /usr/sbin/nologin alice-runtime
sudo cp runtime/deploy/systemd/alice-runtime.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alice-runtime
```

---

## Troubleshooting

### `no such tokenizer: better_trigram`

You ran `pnpm run db:migrate` directly. Don't — use `pnpm run dev` which loads the tokenizer first.

### `AUTH_KEY_UNREGISTERED` or session errors

```bash
rm runtime/alice.session
cd runtime && pnpm run dev   # re-login
```

### `Cannot find module`

```bash
cd runtime && pnpm install
```

### Database locked

Only one Alice instance should run at a time:

```bash
pm2 delete alice-runtime
cd runtime && pnpm run dev
```

### WD Tagger / Anime Classify not starting

These are optional. Alice works without them. Check:

```bash
pm2 logs wd-tagger --lines 20
pm2 logs anime-classify --lines 20
```
