# Alice Runtime

A Telegram userbot runtime built around an append-only event journal and a pure state transition function `step()`, decoupled from I/O in the outer shell.

Workflow uses `pnpm` (Node.js 22+).

## Configuration

`config.toml` stores only environment variable names and can be committed safely. `.env` holds secrets (see `.env.example`):

```bash
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=abcdef123456
TELEGRAM_PHONE=+8613800138000
LLM_API_KEY=sk-xxx
```

For production operation, also set `ALICE_OPERATOR_ID` (required numeric Telegram user ID of the operator) and optionally `ALICE_DAILY_USD_CAP` (default `3`), `ALICE_STATE_DIR` (default `./live/`), `ALICE_DB_PATH` (default `<state-dir>/alice.db`), and `ALICE_CONFIG_PATH`.

## Running

```bash
pnpm install --frozen-lockfile   # at repository root
cd runtime
pnpm login                       # interactive Telegram verification / 2FA -> alice.session
pnpm start:check                 # validate config, migrate SQLite, fold journal (offline)
```

For long-running deployment with PM2, run `pm2 start ecosystem.config.cjs` from the repository root (single-instance lock via `alice.lock`).

Operator commands in private chat: `/ops status | pause | resume | cap <usd> | stop`.
Daily metrics readout: `pnpm northstar live/alice.db`.

## Development

```bash
pnpm -s check   # typecheck + biome lint + vitest suite
```

Offline replay and census utilities live under `src/sim/` (see file headers for usage).

## License

MIT
