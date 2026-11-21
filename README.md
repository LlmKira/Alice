<div align="center">

<h1>Project Alice</h1>

<p>
  <strong>Autonomous Multi-Party Social Simulation for Telegram, Built on Environmental Physics</strong>
</p>

<p>
  <strong>English</strong> &nbsp;&middot;&nbsp;
  <a href="README.zh-CN.md">简体中文</a> &nbsp;&middot;&nbsp;
  <a href="#live-moments">Screenshots</a> &nbsp;&middot;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&middot;&nbsp;
  <a href="#comparison">Comparison</a> &nbsp;&middot;&nbsp;
  <a href="#benchmarks">Benchmarks</a> &nbsp;&middot;&nbsp;
  <a href="#quick-start">Quick Start</a>
</p>

</div>

---

Most chat bots trap LLMs in a webhook loop or bolt prompt rules onto cron timers ("wait 10 minutes", "reply to 1 in 5 messages"). Put them in an active Telegram group and the seams show immediately: once woken up, the model almost always talks, cuts into two-person banter, or gets locked down by ad-hoc filters.

**Project Alice** takes a different approach to **human social simulation**: *stop prescribing rules for how the agent should act, and define the physics of her social environment instead.* Inspired by need- and affordance-driven game AI design and deterministic harness engineering, Alice lives on a real Telegram account via MTProto (`@mtcute/node`) with her own sleep cycle, hunger, continuous mood drift, selective curiosity, and social friction.

<p align="center">
  <em>Supported and powered natively by <a href="https://www.ohmygpt.com"><strong>OhMyGPT</strong></a> &nbsp;&middot;&nbsp; One API key for speech, perception, reranking &amp; real-time credit telemetry</em>
</p>

* **Equilibrium Silence**: Silence has baseline value `0`. Every candidate action across every chat competes on utility (`NSV > 0`) before waking the LLM.
* **Deterministic Event Harness**: The core (`mind/`, `mechanisms/`, `speech/`) reads no system clock, no runtime RNG, and no I/O. Every state replays bit-for-bit from SQLite (`journal.ts`) at zero LLM cost.
* **Blind Turing-Style Result (`aliveness/round-1115`)**: Mixed blindly alongside active human members in the same Telegram groups, detector ROC-AUC dropped from **0.983** to **0.476** (50% = coin flip).

---

## Live Moments

Unscripted screenshots from live Telegram groups, channels, and private DMs (identities anonymized; zero templates scripting replies or stickers):

<table>
  <tr>
    <td width="50%" valign="top">
      <p align="center"><img src=".github/screenshots/group-banter.png" alt="Multi-turn group banter" width="100%"></p>
      <strong>Natural Group Banter</strong><br>
      Keeps up with fast group teasing across turns without slipping into assistant phrasing.
    </td>
    <td width="50%" valign="top">
      <p align="center"><img src=".github/screenshots/security-alert-forward.png" alt="Channel forwarding and reaction" width="100%"></p>
      <strong>Organic Channel Sharing</strong><br>
      Spots a security warning in a subscribed channel (<code>LoopDNS</code>), shares it to warn friends, and plays along when teased.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p align="center"><img src=".github/screenshots/nasa-share.png" alt="NASA Alice Springs share" width="100%"></p>
      <strong>Associative Curiosity</strong><br>
      Connects a Solidot post about "Alice Springs turning green" to her own name and shares it unprompted.
    </td>
    <td width="50%" valign="top">
      <p align="center"><img src=".github/screenshots/private-empathy.png" alt="Private chat awareness" width="100%"></p>
      <strong>Cross-Context Empathy</strong><br>
      Notices an abrupt 2 AM apology in a DM while seeing the same friend active in a shared group, responding candidly with a sticker.
    </td>
  </tr>
</table>

<details>
<summary>More live examples: reflective channel discussions &amp; personal boundaries</summary>
<br>
<table>
  <tr>
    <td width="50%" valign="top">
      <p align="center"><img src=".github/screenshots/channel-forward-opinion.png" alt="Channel reflection" width="100%"></p>
      <strong>Reading the Room</strong><br>
      Reflects on an AI essay, questions her own feelings mid-thread, and backs off gently after a reaction sticker.
    </td>
    <td width="50%" valign="top">
      <p align="center"><img src=".github/screenshots/emotional-sticker.png" alt="Boundary setting" width="100%"></p>
      <strong>Setting Personal Boundaries</strong><br>
      Tracks per-person aversion when treated rudely instead of accepting insults passively.
    </td>
  </tr>
</table>
</details>

---

## How It Works

Instead of asking an LLM "should I talk now?" on every message, Alice runs a continuous two-stage loop:

```text
  Telegram MTProto / Timers / Noise Events (Shell I/O: runtime/src/shell.ts)
         │
         ▼  append-only AliceEvent { at, type, scope, ... }
  SQLite WAL Journal (runtime/src/journal.ts)
         │
         ▼  pure deterministic step(state, event)
┌─────────────────────────────────────────────────────────────────────────┐
│ Pure Core Harness (runtime/src/mind/, mechanisms/, speech/)             │
│  · World Graph       Active groups, DMs, channels & people met          │
│  · 10 Competing Needs Attention, @obligation, cooling, topic, aversion   │
│  · Will (NSV)        Ranks every (chat × action) vs. silence = 0        │
│  · Body & Affect     Borbély sleep-hunger clock + DynAffect OU mood     │
│  · Context Slicing   Role-appropriate memory & turn framing             │
└─────────────────────────────────────────────────────────────────────────┘
         │  wakes speech LLM only when top NSV > 0
         ▼
  Code Mode TS-AST Sandbox (run_code -> tools.send / react / sticker / check_dm)
```

Why this shifts the paradigm for persistent agents: moving from single-turn assistants to month-long companions makes **attention economics, timing, and knowing when not to talk** the real bottleneck. Because every mechanism in `mind/compose.ts` declares isolated state slices, ideas can be swapped and falsified on real logs before touching live users.

<details>
<summary>Mathematical Model: NSV Utility Calculus, 10 Drives, Sleep &amp; DynAffect Mood</summary>

1. **Normalized Subjective Value (`mechanisms/pressure/will.ts`)**:
   Every `(action a, chat h)` candidate competes against silence ($0$):

$$\mathrm{NSV}(a, h) = \sum_{k=1}^{10} \mathrm{relieves}_a[k] \cdot \hat{\tau}_k(h) \cdot g_k \;-\; \lambda(h)\,\bigl(C_{\mathrm{social}}(a, h) + C_{\mathrm{sat}}(a, h)\bigr) \;-\; C_{\mathrm{busy}}(h)$$

   Normalized drives $\hat{\tau}_k(h) = \rho(h) \tanh(P_k(h) / \kappa_k)$ decay via habituation $\rho(h)$ so stale unread rooms fade naturally.

2. **Ten Competing Drives (`drives.ts`)**:
   `attention` ($\kappa=5$), `obligation` ($\kappa=3$, `@mentions`), `thread` ($\kappa=5$, multi-turn momentum), `cooling` ($\kappa=3$, relationship drift), `curiosity` ($\kappa=1$, unexplored rooms), `aversion` ($\kappa=1$, per-person friction), `prospect` ($\kappa=1$, promises), `information` ($\kappa=1.5$, channel items), `topic` ($\kappa=1$, group resonance), and `bond` ($\kappa=3$, familiar speaker pull).

3. **Effort Reciprocity & Cold-DM Consent (`world.ts`, `first-dm.ts`)**:
   Prevents asymmetrical spam when the other person only drops one-word replies or stickers:

$$\mathrm{reciprocity}(h) = \min\!\left(1,\; \frac{\max(0, E_{\mathrm{Alice}} - E_{\mathrm{other}})}{5}\right) \cdot w_{\mathrm{chatType}}$$

   For strangers met in groups, Alice inspects per-source-group acceptance via `tools.check_dm()` or queues a polite in-group ask via `tools.plan_group_dm()`.

4. **Physiology, Affect & Invariants (`life-body.ts`, `affect.ts`, `mind/`)**:
   A Borbély two-process sleep-pressure clock drives fatigue, meals, and bedtime; emotional valence follows an Ornstein–Uhlenbeck process ($\mu_{\mathrm{home}} = +0.19$, half-life $1\text{h}$, $\sigma = 0.15$) nudged by temporal surprise $(1 - 2^{-\Delta t / t_{1/2}})$. Kernel invariants enforce a global ceiling of **6 sends per 60s** alongside unilateral cold-DM budgets.

</details>

---

## Comparison

Based on November 2026 source audits across ~30 open-source bots and academic turn-taking studies, most frameworks focus on adding prompt rules without deterministic replay or controlled human-simulation metrics:

<p align="center">
  <img src=".github/figures/peer-comparison.png" alt="Social Simulation Comparison" width="100%">
</p>

| Project | Decision Core | Replay &amp; Evaluation | Timing &amp; Silence Behavior | Cost &amp; Feedback |
| :--- | :--- | :--- | :--- | :--- |
| **Project Alice** | **10 competing drives + NSV ranking (`NSV > 0`)** | **Zero-cost multi-day replay (`feb-0 / feb-a / feb-b`), blind AUC `0.476`** | **Matches human 1–15m cadence (`32.7%` vs `32.3%`); `39.1%` multi-turn arcs** | **Per-person aversion, effort reciprocity, group cold-DM check** |
| **MaiBot / MaiSaka** (~7k★ QQ) | Logistic gate fit to own planner logs (removed mood/will/schedule) | Single-request replay only; no published AUC | Self-history loop collapsed hot-group replies (`20% -> 4.2%`, `#2109`) | Removed earlier boredom throttling |
| **Moui / MoFox_Bot** | Restores 2D mood on MaiBot fork | No multi-day event replay | Heuristic tuning only | Qualitative adjustments |
| **AstrBot Social Plugins** | Condition-triggered generation + manual expression approval | No closed-loop replay suite | Trigger-driven without turn arcs | Linear counters (`+0.15 / -0.2`); numeric affection exploited via `@` spam |
| **Cahciua / LuckyBot** | Outer gate classifier + non-refusable writer | Production call counts only | Static prompt quota ("~1 in 4–6 msgs") | Spoke in **147 of 148** wakeups (`99.3%`) |
| **CyberGroupmate** | Wait/volume pressure accumulator | No pure-core replay harness | Group wait pressure tracking | 120s uptake check ignoring trivial tokens |
| **elizaOS / N.E.K.O** | Merged generation check or `[PASS]` veto | No multi-day replay simulator | Fixed cooldown timers (`3 ignores -> 8h`, `6 -> 24h`) | Static time locks instead of continuous cost |
| **PITCH / LlamaPIE / ChatGPT Group** | Per-turn classifiers or RL timing policies | Offline single-corpus timing | `PITCH`: `46.4%` early GPT cut-ins; `CHI '26`: `69%` mid-exchange cut-ins | Single-turn timing only; no continuous social/body state |

---

## Benchmarks

To protect chat participants and preserve held-out integrity, **internal evaluation suites (`scenes/`, `eval-artifacts/`) stay private**. All internal benchmark names and measured outcomes from our controlled A/B ablations are disclosed below (`synthetic`, `synthetic-v1`, `synthetic-v2`, `real-v1`, `cap-v1`, `aliveness/round-1115`, `feb-0 / feb-a / feb-b`):

<p align="center">
  <img src=".github/figures/benchmark-gains.png" alt="Benchmark Gains Across Architecture Iterations" width="100%">
</p>

<details>
<summary>Deep Dive: Ablation Breakdown &amp; What Failed Pre-Registration</summary>

* **Blind Detection (`aliveness/round-1115`, n = 34 slices)**: Single-slice `p_ai` ROC-AUC fell **`0.983 -> 0.476`** (uncanny `0.483`, per-speaker `0.497`).
* **Conversation Pacing (`feb-b`, `cap-v1`)**: Turn-based arcs lifted $\ge 2$-turn group conversations from `33.0% -> 39.1%` (humans `36.4%`); 3.78d awake 1–15m reply share reached `32.7%` (humans `32.3%`).
* **Code Mode AST & Diversity (`cap-v1`)**: Eliminated `"1. 2. 3."` checklist monologues (**`77.8% -> 0.0%`**), lifted `distinct-2` (**`0.4893 -> 0.5462`**), cut format defects (`2 -> 0`), and dropped bystander rate (`71.4% -> 55.3%`).
* **First-DM Restraint & Attention Filtering**: Guarded-group cold DMs dropped **`33.3% (4/12) -> 0.0% (0/12)`**; filtering bot chatter & `@other` halved sleep wakes (`16 -> 8`).
* **What We Cut After Failure**: Zero-call `glance` peeking cut group turns by **`-67%`**; rotating 48 canned examples lowered `distinct-2` (`0.489 -> 0.469`); `T=1.2` spiked format defects (`2 -> 5`); synthetic LLM groupmates hallucinated hostility in **`46%`** of turns (`0/26` in real logs).

<p align="center">
  <img src=".github/figures/ablation-contrast.png" alt="Rejected Heuristics vs Promoted Laws" width="100%">
</p>

</details>

---

## Quick Start

### What You Need

* **Node.js** ≥ 22 and **pnpm** ≥ 9
* **One Telegram account** (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE` from [my.telegram.org](https://my.telegram.org/apps))
* **One [OhMyGPT](https://www.ohmygpt.com) API Key** (`OHMYGPT_API_KEY`, or `LLM_API_KEY`): `runtime/src/llm/gateway.ts` integrates natively with `https://api.ohmygpt.com/v1`, routing speech (`google/gemini-3.8-flash`), thinking/vision (`google/gemini-3.5-flash-lite`), album reranking (`cohere/rerank-v5.0-pro`), and real-time `x-cost-credits` spend caps under one key
* *Optional*: `ALICE_OPERATOR_ID` (your Telegram numeric ID for `/ops` controls), `EXA_API_KEY` (web lookups), `Python 3.11+` + `uv` (local CPU ONNX sticker tagger in `services/tagger`), and `pm2`

### Install & Launch

```bash
git clone https://github.com/LlmKira/Alice.git
cd Alice
pnpm install --frozen-lockfile

cp runtime/.env.example runtime/.env
# Fill in TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE, and OHMYGPT_API_KEY
```

Verify offline health first (safe, zero network calls), log in once, then start:

```bash
cd runtime
pnpm start:check    # Validates config, migrates SQLite, replays journal offline
pnpm -s check       # Runs TypeScript check, Biome lint, and deterministic tests
pnpm login          # One-time interactive MTProto verification -> session file
pnpm start          # Launch foreground runtime (or: pm2 start ../ecosystem.config.cjs)
```

<details>
<summary>For AI Agents: Zero-Guess Deployment Guide</summary>

If you are an autonomous coding agent deploying Project Alice for a user:

1. **Native OhMyGPT Integration**: Project Alice uses **[OhMyGPT](https://www.ohmygpt.com)** natively (`https://api.ohmygpt.com/v1` in `runtime/src/llm/gateway.ts`) with automatic `x-cost-credits` budget accounting. Request a single `OHMYGPT_API_KEY` (legacy `LLM_API_KEY` also works) and write it to `runtime/.env`. No separate Google, Cohere, or DeepSeek provider setup is required.
2. **Required vs Optional Env (`runtime/.env`)**:
   - Required: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE`, `OHMYGPT_API_KEY` (or `LLM_API_KEY`).
   - Production operator control (recommended): `ALICE_OPERATOR_ID` (user's numeric Telegram ID), `ALICE_DAILY_USD_CAP` (default `3`).
   - Strictly optional: `EXA_API_KEY`, `ELEVENLABS_API_KEY` / `MINIMAX_API_KEY`, `ALICE_TAGGER_URL=http://127.0.0.1:39100`. Omitting them cleanly disables those optional tools without startup errors.
3. **Always Run `--check` Before Live**: Run `cd runtime && pnpm start:check && pnpm -s check` before `pnpm login`. `pnpm start:check` performs zero network calls and validates config/SQLite/core purity.
4. **Daemonization**: Telegram MTProto auth (`pnpm login`) requires interactive code/2FA input from the user once. Afterward, run `bash services/tagger/setup.sh` (optional local ONNX tagger) and launch via `pm2 start ecosystem.config.cjs` from repo root (guarded by `alice.lock` single-instance lock).

</details>

---

## Project Layout, Sponsorship & License

```text
.
├── ecosystem.config.cjs    PM2 config (alice-runtime + optional alice-tagger)
├── runtime/                TypeScript MTProto runtime, pure core & test suite
│   ├── src/mind/           Events, affordances, compose kernel, invariants
│   ├── src/mechanisms/     10 drives, NSV will, sleep/hunger, DynAffect, memory
│   ├── src/speech/         Audience framing & Code Mode AST decisions
│   ├── src/llm/gateway.ts  OhMyGPT native unified gateway & credit billing
│   └── src/telegram/       @mtcute MTProto acts, rate ceilings & voice
└── services/tagger/        Optional local FastAPI ONNX sticker/image tagger
```

**Research Infrastructure**: Supported and sponsored by **[OhMyGPT](https://www.ohmygpt.com)**, providing unified multi-model inference and per-call credit telemetry for Project Alice.

Released for academic research, experimentation, and personal non-commercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE) (`Copyright (c) 2026 LLM Kira`). Commercial usage is not permitted without a separate license. Research manuscripts, optimization logs, and benchmark datasets (`scenes/`, `eval-artifacts/`) are withheld to protect user privacy.
