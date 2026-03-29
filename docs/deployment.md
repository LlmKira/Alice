# Deployment Guide

This guide walks you through getting Alice running from zero.

## Prerequisites

| Requirement | Version | Purpose |
|------------|---------|---------|
| Node.js | 20+ | Runtime |
| pnpm | 9+ | Package manager |
| Python | 3.13+ | Auxiliary services |
| [uv](https://github.com/astral-sh/uv) | latest | Python package manager |
| [pdm](https://pdm-project.org/) | latest | wd-tagger dependencies |
| pm2 | latest | Process manager (`npm i -g pm2`) |

## 1. Clone

```bash
git clone --recurse-submodules https://github.com/LlmKira/alice.git
cd alice
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

## 2. Get Telegram API Credentials

1. Go to [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your Telegram phone number
3. Create a new application (any name is fine)
4. Note down **API ID** and **API Hash**

> Alice runs as a **userbot** (your personal account), not a bot created via BotFather. This gives her full Telegram capabilities — reading all messages, browsing channels, sending stickers, etc.

## 3. Get an LLM Endpoint

Alice needs an OpenAI-compatible API endpoint. Any of these work:

| Provider | Notes |
|----------|-------|
| [**OhMyGPT**](https://www.ohmygpt.com) | **Recommended** — 200+ models, no VPN needed for CN users, OpenAI-compatible |
| [OpenRouter](https://openrouter.ai/) | Multi-model gateway |
| [DeepSeek](https://platform.deepseek.com/) | Cost-effective |
| [OpenAI](https://platform.openai.com/) | GPT-4o etc. |
| [Google AI Studio](https://aistudio.google.com/) | Gemini models (free tier available) |
| Local (Ollama, vLLM) | Self-hosted, `http://localhost:11434/v1` |

You need a **base URL**, **API key**, and **model name**.

## 4. Configure

```bash
cd runtime
cp .env.example .env
```

Edit `.env` — the **required** fields:

```bash
# Telegram
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_PHONE=+8613800138000

# LLM (OhMyGPT recommended: https://www.ohmygpt.com)
LLM_BASE_URL=https://api.ohmygpt.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gemini-2.5-flash-preview-05-20
```

See `.env.example` for all optional features (vision, TTS, search, music, etc.).

## 5. Install Dependencies

```bash
# Runtime (in runtime/)
pnpm install

# Auxiliary services
cd ../services/anime-classify && uv sync
cd ../wd14-tagger-server && pdm install
```

## 6. Database

```bash
cd runtime
pnpm run db:migrate
```

This creates `alice.db` (SQLite) with all required tables.

## 7. First Run (Interactive Login)

The first time Alice starts, she needs to authenticate with Telegram. This is interactive — you'll receive a login code on Telegram.

```bash
cd runtime
pnpm run dev
```

Follow the prompts:
1. Enter the verification code sent to your Telegram
2. If you have 2FA enabled, enter your password

After successful login, a session file is created. Subsequent starts are automatic.

## 8. Production Setup (pm2)

Once the interactive login is complete:

```bash
# From project root
pm2 start ecosystem.config.cjs

# Check status
pm2 status
pm2 logs alice-runtime --lines 50
```

This starts:
- **alice-runtime** — the main engine
- **wd-tagger** — image tagging service (port 39100)
- **anime-classify** — anime image detector (port 39101)

### Managing processes

```bash
pm2 restart alice-runtime    # after code changes
pm2 stop alice-runtime       # stop
pm2 delete all               # remove all processes
```

### Auto-restart on system boot

```bash
pm2 startup                  # generate startup script
pm2 save                     # save current process list
```

## 9. Verify It's Working

```bash
# Check logs
pm2 logs alice-runtime --lines 20

# Check pressure field
sqlite3 runtime/alice.db "SELECT tick, p1, p2, p3, p4, p5, p6, api FROM tick_log ORDER BY tick DESC LIMIT 5;"

# Check recent actions
sqlite3 runtime/alice.db "SELECT tick, voice, action_type, chat_id, confidence FROM action_log ORDER BY tick DESC LIMIT 5;"
```

If you see tick_log entries with growing pressure values and occasional action_log entries — Alice is alive.

## Optional: systemd (Production Server)

For a hardened production deployment, see `runtime/deploy/systemd/`:

```bash
# Create service account
sudo useradd --system --home /var/lib/alice-runtime --shell /usr/sbin/nologin alice-runtime

# Install service
sudo cp runtime/deploy/systemd/alice-runtime.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alice-runtime
```

The systemd unit includes security hardening (PrivateTmp, ProtectSystem=strict, NoNewPrivileges, etc.).

## Optional Features

| Feature | Env Vars | What it enables |
|---------|----------|----------------|
| Vision | `VISION_MODEL` | Alice sees images/stickers/photos |
| TTS | `TTS_BASE_URL`, `TTS_API_KEY` | Alice sends voice messages |
| ASR | `ASR_BASE_URL`, `ASR_API_KEY` | Alice transcribes incoming voice |
| Web Search | `EXA_API_KEY` | Alice can search the web |
| Music | `MUSIC_API_BASE_URL` | Alice can recommend/search music |
| YouTube | `YOUTUBE_API_KEY` | Alice can search videos |

All optional — Alice works without them, just with reduced capabilities.

## Troubleshooting

### "AUTH_KEY_UNREGISTERED" or session errors

Delete the session file and re-authenticate:
```bash
rm runtime/alice.session
pnpm run dev  # interactive login again
```

### "Cannot find module" errors

```bash
cd runtime && pnpm install
```

### Database locked errors

Make sure only one Alice instance is running:
```bash
pm2 delete all
pnpm run dev
```

### WD Tagger / Anime Classify not starting

These are optional services. If they fail, Alice degrades gracefully (skips image tagging). Check:
```bash
pm2 logs wd-tagger --lines 20
pm2 logs anime-classify --lines 20
```
