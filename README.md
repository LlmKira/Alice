<img src=".github/banner.png" width="100%" alt="Alice — Event-Sourced Autonomous Companion Runtime" />

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">Alice</h1>

<p align="center">
  <a href="https://github.com/LlmKira/Alice"><img src="https://img.shields.io/github/stars/LlmKira/Alice?style=flat&colorA=080f12&colorB=f0c040" alt="stars"></a>
  <a href="https://t.me/Openai_LLM"><img src="https://img.shields.io/badge/Telegram-%235AA9E6?logo=telegram&labelColor=FFFFFF" alt="telegram"></a>
  <a href="https://github.com/LlmKira/Alice/issues"><img src="https://img.shields.io/github/issues/LlmKira/Alice?style=flat&colorA=080f12&colorB=ef4444" alt="issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License"></a>
</p>

> [!NOTE]
> Alice is an autonomous Telegram userbot runtime built around a **pure, deterministic, event-sourced core** and a **need-based utility decision layer (the Will)**. Rather than scripting rigid conversation rules or prompt-level guardrails, behavior emerges from world laws: external obligations, relationship dynamics, bodily rhythms, social reception, and continuous costs.

---

## Core Philosophy

Most LLM chat bots are reactive request-response wrappers or heuristic rule engines (`if ignored >= 3: stop`). Alice separates **when, where, and what kind of act to consider** (a deterministic pure core) from **what to say** (a single LLM call per wake using TypeScript Code Mode).

- **Open Guidance**: Guidance shapes classes of situations (e.g., someone went cold, someone is upset) as factual context, never scripted replies or narrow behavioral bans.
- **Adaptive Design**: Group tempo, relationship familiarity, channel sharing selectivity, first-DM acceptance, and surprise-weighted mood feedback adapt from observed interaction history rather than hand-tuned global thresholds.
- **Deterministic Replay**: `mind/`, `mechanisms/`, and `speech/` never read the system clock, random sources, or I/O. Every timestamp and random draw enters as an event in an append-only SQLite Journal. Replaying any event window produces byte-identical state and decisions.
- **Soft Utility Over Hard Gates**: Preferences ("don't spam", "don't intrude", "stop chasing someone who doesn't reply") live inside one continuous objective function (`NSV`). Hard constraints protect only three safety invariants.

---

## System Architecture

```text
Telegram (mtcute) ──▶ Append-only Journal (SQLite)
                            │
                            ▼
                 pure step(state, event) ──▶ { nextState, effects[] }
                            ▲                         │
                            └─── typed results ◀── Shell (LLM / Telegram / Timers)
```

Five components close the behavioral loop:

1. **World Fold (`mechanisms/pressure/world.ts`)**: Folds messages, reactions, membership updates, perception labels (`tone`, `stop`/`hush`/`aloof`), and action outcomes into a typed social graph of chats, contacts, threads, commitments, and receptions (`replied`, `cold`, `ignored`, `unheard`, `rejected`).
2. **Composable Mechanisms (`mind/compose.ts`, `mechanisms/registry.ts`)**: Every behavioral mechanism declares the state slices it reads and writes (`Slices`). Write collisions fail fast at composition time; ablating a feature is removing one slot from `PRODUCTION`.
3. **The Will (`mechanisms/pressure/will.ts`)**: Evaluates every available `(chat, affordance)` pair and wakes the speech model only when the highest Net Social Value exceeds `0`.
4. **Single-Call Code Mode (`speech/decision.ts`, `mind/affordances.ts`)**: On wake, the LLM receives `SOUL.md`, a factual context card (including the top wake causes), chat timeline, and a TypeScript SDK of currently available actions. It emits straight-line `await tools.<action>(...)` calls inside a single `run_code` tool call, parsed statically via the TypeScript AST and never executed.
5. **Closed-Loop Reception (`mechanisms/pressure/feedback.ts`, `rejection.ts`, `fairness.ts`)**: How others respond feeds back into mood, sharing taste, service debt, and per-person/per-group aversion.

---

## Mathematical Formulation

### 1. Net Social Value & Adaptive Rhythm

For an available affordance $a$ in chat $h$ at time $t$, the Will computes:

$$\mathrm{NSV}(a, h) = \underbrace{\sum_{k} r_a[k] \cdot g_k(h) \cdot \hat{X}_k(h)}_{\text{bounded relief}} \;-\; \lambda_h \Bigl(C_{\mathrm{soc}}(a,h) + \hat{V}_h \bigl(1 - r_a[V]\bigr) + C_{\mathrm{sat}}(a,h)\Bigr) \;-\; C_{\mathrm{body}}(a,h)$$

- **Zero Silence Baseline**: Silence has value $0$. Only candidates with $\mathrm{NSV} > 0$ are eligible; at each open rhythm tick, the Will wakes only the global `argmax`.
- **Considered, Declined, Consumed**: If woken for `(a, h)` and the model chooses silence, the drives relieved by that wake are consumed and regrow from that moment without altering world contact timestamps.
- **Intrinsic Gain Modulation ($g_k$)**: Affect valence and bodily sociability modulate the six intrinsic drives (`cooling`, `curiosity`, `information`, `prospect`, `topic`, `bond`) within $g_k \in [0.65, 1.45]$, while extrinsic drives (`attention`, `obligation`, `thread`, `aversion`) remain at $1.0$ so addressed messages are still answered when mood is low.
- **Urgency-Modulated Cost Sensitivity ($\lambda_h$)**: $\lambda_h = \lambda_0 \cdot \varphi_h$ with $\lambda_0 = 1.5$, where $\varphi_h = 0.3$ if effective obligation $O_h > 0.2$, $\varphi_h = 0.5$ if in an active conversation turn, and $\varphi_h = 1.0$ otherwise.
- **Demand-Driven Wake Rhythm**:

$$\Delta t = \Delta t_{\min} + (\Delta t_{\max} - \Delta t_{\min}) \exp\!\left(-\frac{\mathrm{API}_{\mathrm{peak}}}{\kappa_t}\right), \quad \Delta t_{\min} = 1\,\mathrm{s},\; \Delta t_{\max} = 300\,\mathrm{s},\; \kappa_t = 1$$

where $\mathrm{API}_{\mathrm{peak}}$ tracks only external demand drives so internal urges never cause tick storms.

### 2. Normalized Drives & Habituation

Raw drives $X_k(h)$ are squashed with per-drive scale $\kappa_k$ and habituated by recent decision frequency $H_h$ ($\tau_H = 30\,\mathrm{min}$):

$$\hat{X}_k(h) = \tanh\!\left(\frac{X_k(h)}{\kappa_k}\right) \cdot \rho_h, \qquad \rho_h = \begin{cases} 1, & k \in \{\text{obligation}, \text{aversion}\} \\ \dfrac{1}{1 + 0.5\, H_h}, & \text{otherwise} \end{cases}$$

| Drive | Formula / Mechanism | $\kappa_k$ |
|---|---|---|
| **Attention ($A_h$)** | $\max\!\bigl(\mathrm{ewms}_h \cdot 2^{-\Delta t_{\mathrm{awake}}/1\mathrm{h}},\; \ln(1+\mathrm{unread}_h)\bigr) \cdot w_{\mathrm{tier}} \cdot w_{\mathrm{chat}}^A$ (filtered via `group-filter`) | $5$ |
| **Obligation ($O_h$)** | $\mathrm{pending}_h \cdot 2^{-\Delta t_{\mathrm{awake}}/1\mathrm{h}} \cdot w_{\mathrm{tier}} \cdot w_{\mathrm{chat}}^O$ (private $w^O=2$, group $1$) | $3$ |
| **Thread ($T_h$)** | $w_{\mathrm{thread}} \bigl((1 + a/\mathrm{day})^{1.5} - 1\bigr)$ for unanswered address age $a < 7\,\mathrm{d}$ ($w_{\mathrm{thread}}$: $2$ private, $0.5$ group) | $5$ |
| **Prospect ($P_h$)** | $2\,\sigma\!\bigl(5(x - \tfrac{1}{2})\bigr)\cdot f(t)$, $x = \min\!\bigl(1, 1 - (d - t)/L\bigr)$ for scheduled commitments | $1$ |
| **Cooling ($C_h$)** | $w_{\mathrm{tier}} \cdot \sigma\!\Bigl(2.5\bigl[\ln\!\bigl(1 + \frac{s}{\tau_0 \cdot 2^{\min(r-1, 6)}}\bigr) - \ln\!\bigl(1 + \frac{\theta_c}{\tau_0}\bigr)\bigr]\Bigr)$ ($\tau_0 = 600\,\mathrm{s}$; group $\theta = \mathrm{clamp}(10\cdot\mathrm{gap}_{\mathrm{EMA}}, 30\,\mathrm{m}, 7\,\mathrm{d})$) | $3$ |
| **Curiosity ($U_h$)** | Bounded surprise on contact activity deviation (private & reachable targets only) | $1$ |
| **Sharing Desire ($I_h$)** | $\max_m \bigl(\mathrm{freshness}_c \cdot \mathrm{rel}_{\mathrm{IDF}} \cdot w_{\mathrm{near}} \cdot \mathrm{novelty} \cdot 6\bigr)$, gated to beat the last $W_h = \frac{\text{arrivals/day}}{\text{shares/day}}$ items and $\tanh(I_h/1.5) \ge 0.5$ | $1.5$ |
| **Group Topic ($G_{\mathrm{top}}$)** | Cross-chat IDF cosine salience $\ge 0.3$ against memory/diary/topics ($t_{1/2} = 10\,\mathrm{min}$) | $1$ |
| **Group Bond ($G_{\mathrm{bond}}$)** | Speaker's recent responded interaction strength ($t_{1/2} = 24\,\mathrm{h}$) | $3$ |
| **Aversion ($V_h$)** | $+0.5$ ignored, $+0.5$ negative emoji, $+1.0$ rejected ($\tau = 2\,\mathrm{h}$ group, $8\,\mathrm{h}$ private; not reset by ordinary messages) | $1$ |

### 3. Social, Saturation, Exit & Bodily Costs

- **Social Cost ($C_{\mathrm{soc}}$)**: $0.3\,\mathrm{dist} + 0.3\,\mathrm{imp} + 0.3\,\mathrm{temp}$, combining effort-weighted reciprocity ($\mathrm{hers} - \mathrm{theirs}$, so `"1"` or stickers do not erase conversational debt), Dunbar tier distance ($\mathrm{tier}/500$), staleness, act intrusiveness, and 30-min global turn density.
- **Unbounded Unilateral Saturation ($C_{\mathrm{sat}}$)**:

$$C_{\mathrm{sat}} = 2\,\mathrm{rate} + 1.5\,\mathrm{cool} + 2\left(\frac{k_h}{O}\right)^2 + 1.5\,\mathrm{fail}$$

  where $k_h$ counts unanswered message-leaving acts ($O = 3$ private, $4$ group; $30\,\mathrm{d}$ half-life, reset only on real response). Because $(k_h/O)^2$ is uncapped, the companion is guaranteed to fall silent toward non-responsive private contacts rather than spamming indefinitely.
- **First-DM Acceptance & Fairness**: Quiet existing DMs accrue a bounded fairness discount up to $45\%$ off $C_{\mathrm{soc}}$ ($\tau = 6\,\mathrm{h}$). Cold first-DM outreach from a group pays an adaptive cost learned per source group via a $\mathrm{Beta}(2,4)$ prior, a 2-h group cooldown, group rejection coupling, and a 24-h `PEER_FLOOD` breaker.
- **Exit Cost ($C_{\mathrm{exit}}$)**: $0.3\tanh(I_h/3) + 0.3/(1 + n_h)$, balancing accumulated responded investment $I_h$ against thin-evidence wait value.
- **Borbély Two-Process Sleep & Hunger ($C_{\mathrm{body}}$)**: Sleep pressure $S$ integrates minute-by-minute ($\tau_r = 18.2\,\mathrm{h}$ awake, $\tau_d = 4.2\,\mathrm{h}$ asleep) against 24-h circadian thresholds ($H_0 = 0.67, L_0 = 0.17$, amplitude $0.12$), adding $30\cdot\mathrm{depth}$ cost while asleep and pausing unread/obligation aging during sleep. Hunger grows toward $1$ with $\tau = 5\,\mathrm{h}$ and raises meal priority above filler activities.
- **DynAffect Mood & Surprise-Weighted Reception**: Valence follows an Ornstein–Uhlenbeck process ($\mu = +0.19$, $\sigma = 0.15$, $t_{1/2} = 1\,\mathrm{h}$). Positive reception lifts valence proportionally to surprise $(1 - \mathrm{usualUptake})$.

### 4. Hard Safety Invariants (Only 3)

1. **Send-rate ceiling**: At most **6** message-leaving acts per chat within any 60-second window.
2. **Strict chat routing**: Every act executes only in the chat that triggered the decision; quote/reaction IDs must belong to that chat's timeline.
3. **No blind retry**: Failed or `outcome_unknown` acts are never automatically retried.

---

## Ablation & Benchmark Comparisons

> **Note**: Our evaluation datasets, synthetic/real moment benchmarks, and internal optimization workflows are kept private. Below are the verified results from our pre-registered A/B ablations, zero-cost closed-loop censuses, and blind judge evaluations.

| Study | Comparison | Key Verified Result | Outcome |
|---|---|---|---|
| **Will Layer** | Will vs. handwritten triggers (`12h` real-model replay) | Addressed coverage `99.2%` vs `99.4%`; busy group turns `17.6` vs `26.4`/group/day; unprompted DMs `21` vs `0` | **Promoted** |
| **Action Format** (`exec-mode`) | Code Mode (`run_code` TS AST) vs. continuation / native tools / bash | Appropriate internal-act usage **`57%` vs `22%`** (`69%` vs `33%` w/ 2-min lead); pairwise taste **`49 : 25`** (5 ties); defects `3.8%` vs `3.3%`; off-topic `0%` | **Promoted** |
| **Conversation Arc** (`dwell`) | Turn-based option vs. 5-min `floor` | $\ge 2$-turn group arcs **`33.0% → 39.1%`** (human `36.4%`), TVD `0.108 → 0.100`; two `12h` real-model windows: `14.3% → 22.6%` and `17.6% → 34.5%` (human `35.5%`, `38.6%`) | **Promoted** |
| **Group Attention Filter** | Filtering bots, uncaptioned media, `@other` (`9.19d` census) | Calls `2736 → 2664` (`-2.6%`); unaddressed wakes while asleep **`16 → 8`**; 10-min directed response `0.712 → 0.718` | **Promoted** |
| **Sharing Desire** (`desire`) | Adaptive channel sharing vs. baseline (`60` live moments) | Worse faults `2` vs `4` (`30` ties); `0` forced insertions; capped $\le 2$/chat/day (human active-quarter p90 `2.12`) | **Promoted** |
| **First-DM Delegation** | Per-group adaptive cost + `check_dm` / `plan_group_dm` | Guarded group cold DMs **`33.3% (4/12) → 0.0% (0/12)`** (`check_dm` called `10/12`); friendly group kept at `16.7% (1/6)` | **Promoted** |
| **Expression Diversity** (`prune-vs`) | Prune 6 fixed openings + divergent `inner` + 6h echo (`22 × 3` reps) | `distinct-2` **`0.4893 → 0.5462`**, `distinct-3` **`0.7718 → 0.8157`**; format defects `2 → 0`; bystander rate **`71.4% → 55.3%`** (`-16.1pp`, AI-ness `0%`); pairwise **`18 : 12 : 4`** | **Promoted** |
| **5-Ring Closed Loop** (`loop-v2`) | `loop-v2` vs. `loop-delegated` (`40` real moments + `3.78d` census) | Checklist `think` templates (`1. 2. 3.`) **`77.8% (28/36) → 0.0% (0/34)`**; awake 1–15m reply share **`0.327`** (human `0.323`) | **Promoted** |
| **Blind Human-vs-AI** | Anonymized group slices (`16` Alice vs. `18` active humans) | AI-detection AUC **`0.983 → 0.476`** (uncanny AUC `0.483`, per-speaker AUC `0.497`, mean $p_{\mathrm{AI}}$ `0.224` vs `0.216`) | **Crossed `< 0.60` bar** |

### Selected Negative Results

- **Zero-call `glance` peeking**: Saved `29%` model calls (`1298 → 916`), but collapsed group participation by `67%` (`5.30 → 1.76` turns/group/day) — **rejected**.
- **`follow-reader` (waking on every watched group message)**: Doubled daily volume and exceeded active-member p90 in 3 small groups — **rejected**.
- **Rotating 48-example pool (`rot`) & high temperature (`T = 1.2`)**: `rot` degraded `distinct-2` (`0.4893 → 0.4694`); `T = 1.2` more than doubled format defects (`2 → 5`) — **rejected**.
- **Uncalibrated LLM group simulator**: Turned hostile after `46%` of turns in calm/joking chats where real humans had `0%` hostility (`0/26`) — **rejected** in favor of empirically calibrated responders.

---

## Project Structure

```text
.
├── ecosystem.config.cjs        # PM2 configuration (alice-runtime + alice-tagger)
├── pnpm-workspace.yaml
├── runtime/                    # TypeScript pure-core + shell runtime
│   ├── config.toml             # Non-secret env variable mapping
│   ├── .env.example            # Secret environment template
│   ├── SOUL.md                 # Persona definition
│   ├── deploy/systemd/         # Hardened systemd unit
│   ├── src/
│   │   ├── index.ts            # Bootstrap & startup check (--check / --login)
│   │   ├── journal.ts          # Append-only SQLite event store
│   │   ├── shell.ts            # Effect execution, LLM & Telegram I/O
│   │   ├── mind/               # Pure state machine, compose kernel, affordances, invariants
│   │   ├── mechanisms/         # Composable mechanisms & pressure/will layer
│   │   ├── speech/             # Prompt rendering, Code Mode AST parser, media & reflection
│   │   ├── llm/                # Speech model, vision/tone perception, errands (Exa), TTS
│   │   ├── telegram/           # @mtcute MTProto adapter, acts, rate gates, album, phone calls
│   │   ├── ops/                # Operator commands (/ops status | pause | resume | cap | stop)
│   │   └── sim/                # Deterministic replay, footprint census & platform simulator
│   └── test/                   # Vitest unit & closed-loop property tests
└── services/
    └── tagger/                 # Optional local CPU ONNX WD-v3 image tagger (127.0.0.1:39100)
```

---

## Quick Start

### Prerequisites

- **Node.js 22+** and **pnpm**
- A **Telegram user account** (MTProto via `@mtcute/node`, not Bot API; obtain `API_ID` / `API_HASH` from [my.telegram.org](https://my.telegram.org/apps))
- An **OpenAI-compatible LLM endpoint** (`LLM_API_KEY`)
- **Optional**: [Exa](https://exa.ai/) (`EXA_API_KEY`) for web lookup errands, MiniMax / ElevenLabs (`TTS_PROVIDER`) for voice messages, Python 3.12+ with `uv` for the local `alice-tagger` vision service, and `pm2` for daemon management

### Setup & First Login

```bash
git clone https://github.com/LlmKira/Alice.git
cd Alice
pnpm install --frozen-lockfile

cp runtime/.env.example runtime/.env
# Edit runtime/.env with TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE, LLM_API_KEY,
# and ALICE_OPERATOR_ID (your numeric Telegram user ID)
```

Authorize Telegram interactively once, verify configuration and replay health, then run tests:

```bash
cd runtime
pnpm login          # Interactive login code / 2FA -> writes session
pnpm start:check    # Validates config, migrates SQLite, replays journal (no network/LLM calls)
pnpm -s check       # Typecheck + biome lint + full vitest suite
```

### Production Deployment (PM2)

Optional local image tagger (CPU ONNX, keeps images local):

```bash
bash services/tagger/setup.sh
```

Start with PM2 from the repository root:

```bash
pm2 start ecosystem.config.cjs
pm2 logs alice-runtime
pm2 save
```

Operator commands (send in private chat from `ALICE_OPERATOR_ID`):

```text
/ops status | pause | resume | cap <usd> | stop
```

Daily readout from the live journal:

```bash
cd runtime && pnpm northstar live/alice.db
```

---

## License

[MIT](LICENSE)
