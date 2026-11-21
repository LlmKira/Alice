<img src=".github/banner.png" width="100%" alt="Alice — 事件溯源自主数字伙伴运行时" />

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
> Alice 是一个基于**纯函数事件溯源核心**与**需求效用决策层（意愿层 / The Will）**构建的自主 Telegram userbot 运行时。它不靠写死的对话规则或提示词补丁控制行为，而是通过定义世界法则——外部义务、关系亲疏、作息与饥饿、社交反馈以及连续代价——让行为自然涌现。

---

## 核心理念

绝大多数大模型聊天机器人只是被动的请求-响应封装，或是硬编码启发式规则的集合（例如「连续被忽略 3 次就闭嘴」）。Alice 将**什么时候、在哪里、以什么动作醒来**（纯函数确定性核心）与**具体说什么**（每次唤醒仅做一次基于 TypeScript Code Mode 的模型调用）彻底分离。

- **开放性引导**：只向模型呈现一类情境的客观事实（例如某人变冷淡、某人情绪低落），绝不替它写死台词或收窄动作空间。
- **自适应设计**：群聊节奏、关系熟悉度、频道分享挑剔度、初次私聊接受率以及基于意外度的情绪反馈，均从真实互动历史中自适应学习，而非依赖拍脑袋的全局阈值。
- **确定性回放**：`mind/`、`mechanisms/` 与 `speech/` 严禁读取系统时钟、随机数或执行 I/O。一切时间戳与随机采样都作为事件写入只追加的 SQLite Journal。回放任意事件窗口，都会得到逐字节完全一致的状态与决定。
- **用连续效用替代硬闸门**：所有偏好（「少刷屏」「别硬插话」「对方一直不回就停手」）全部进入同一个连续目标函数（`NSV`）。硬约束只保留三条安全不变量。

---

## 系统架构

```text
Telegram (mtcute) ──▶ 只追加事件日志 Journal (SQLite)
                            │
                            ▼
                 纯函数 step(state, event) ──▶ { nextState, effects[] }
                            ▲                         │
                            └──── 类型化结果 ◀── 外壳 Shell (LLM / Telegram / 计时器)
```

五环闭环构成完整生命周期：

1. **世界折叠（`mechanisms/pressure/world.ts`）**：将消息、表情反应、群成员变动、口气感知标签（`tone`、`stop`/`hush`/`aloof`）与动作执行结果折叠为类型化的社交图谱（会话、联系人、未接话头、承诺以及 5 类反应结果：`replied`、`cold`、`ignored`、`unheard`、`rejected`）。
2. **可组合机制内核（`mind/compose.ts`、`mechanisms/registry.ts`）**：每个机制显式声明自己读写的切片（`Slices`）。多写入者冲突在组合阶段即报错；消融某项机制只需从 `PRODUCTION` 中移除对应插槽。
3. **意愿层（`mechanisms/pressure/will.ts`）**：对所有可用的 `(会话, 可供性)` 组合计算净社交价值（`NSV`），仅当全局最高分严格大于 `0` 时才唤醒发言模型。
4. **单次 Code Mode 调用（`speech/decision.ts`、`mind/affordances.ts`）**：唤醒后，模型看到 `SOUL.md`、事实卡片（含本次唤醒原因）、聊天时间线与当前可用动作的 TypeScript SDK 声明，在单次 `run_code` 工具调用中输出直线型 `await tools.<action>(...)` 调用；外壳通过 TS 语法树静态解析，从不实际执行代码。
5. **反馈闭环（`mechanisms/pressure/feedback.ts`、`rejection.ts`、`fairness.ts`）**：他人是否接话、是否点负面表情或拒绝，即时回流至情绪效价、频道分享口味、服务债折扣与按人/按群记账的回避度。

---

## 数学公式与机理

### 1. 净社交价值（NSV）与自适应节律

对于时间 $t$ 在会话 $h$ 中可用的可供性 $a$，意愿层计算：

$$\mathrm{NSV}(a, h) = \underbrace{\sum_{k} r_a[k] \cdot g_k(h) \cdot \hat{X}_k(h)}_{\text{有界缓解收益}} \;-\; \lambda_h \Bigl(C_{\mathrm{soc}}(a,h) + \hat{V}_h \bigl(1 - r_a[V]\bigr) + C_{\mathrm{sat}}(a,h)\Bigr) \;-\; C_{\mathrm{body}}(a,h)$$

- **沉默零基准**：沉默的价值恒为 $0$。仅 $\mathrm{NSV} > 0$ 的候选进入池中；每次节律窗口开启时，意愿层确定性地取全局 `argmax` 唤醒。
- **考虑过就消耗**：若在 `(a, h)` 被唤醒后模型选择沉默，该唤醒本可缓解的驱动在此时刻重置并重新累积，而不会篡改真实联系人互动时间戳。
- **内在驱动增益调制（$g_k$）**：心情效价与身体社交度对 6 项内在驱动（`cooling`、`curiosity`、`information`、`prospect`、`topic`、`bond`）施加有界乘数 $g_k \in [0.65, 1.45]$；外部驱动（`attention`、`obligation`、`thread`、`aversion`）保持 $1.0$，确保情绪低落时依然回应找她的人。
- **义务调制的代价敏感度（$\lambda_h$）**：$\lambda_h = \lambda_0 \cdot \varphi_h$（$\lambda_0 = 1.5$），当有效义务 $O_h > 0.2$ 时 $\varphi_h = 0.3$，处于当前对话轮次时 $\varphi_h = 0.5$，其余情况为 $1.0$。
- **外部需求驱动的自适应节律**：

$$\Delta t = \Delta t_{\min} + (\Delta t_{\max} - \Delta t_{\min}) \exp\!\left(-\frac{\mathrm{API}_{\mathrm{peak}}}{\kappa_t}\right), \quad \Delta t_{\min} = 1\,\mathrm{s},\; \Delta t_{\max} = 300\,\mathrm{s},\; \kappa_t = 1$$

其中 $\mathrm{API}_{\mathrm{peak}}$ 仅统计外部需求驱动，防止内部冲动随联系人增多而触发节律风暴。

### 2. 驱动归一化与习惯化

原始驱动 $X_k(h)$ 经固定尺度 $\kappa_k$ 压缩并乘以习惯化因子 $\rho_h$（$\tau_H = 30\,\mathrm{min}$）：

$$\hat{X}_k(h) = \tanh\!\left(\frac{X_k(h)}{\kappa_k}\right) \cdot \rho_h, \qquad \rho_h = \begin{cases} 1, & k \in \{\text{obligation}, \text{aversion}\} \\ \dfrac{1}{1 + 0.5\, H_h}, & \text{其他驱动} \end{cases}$$

| 驱动 | 计算公式 / 机理 | $\kappa_k$ |
|---|---|---|
| **注意力（$A_h$）** | $\max\!\bigl(\mathrm{ewms}_h \cdot 2^{-\Delta t_{\mathrm{awake}}/1\mathrm{h}},\; \ln(1+\mathrm{unread}_h)\bigr) \cdot w_{\mathrm{tier}} \cdot w_{\mathrm{chat}}^A$（经 `group-filter` 过滤机器人/无配文媒体/@他人） | $5$ |
| **回应义务（$O_h$）** | $\mathrm{pending}_h \cdot 2^{-\Delta t_{\mathrm{awake}}/1\mathrm{h}} \cdot w_{\mathrm{tier}} \cdot w_{\mathrm{chat}}^O$（私聊 $w^O=2$，群聊 $1$） | $3$ |
| **未接话头（$T_h$）** | $w_{\mathrm{thread}} \bigl((1 + a/\mathrm{day})^{1.5} - 1\bigr)$，未接持续时间 $a < 7\,\mathrm{d}$（私聊 $2$，群聊 $0.5$） | $5$ |
| **承诺截止（$P_h$）** | $2\,\sigma\!\bigl(5(x - \tfrac{1}{2})\bigr)\cdot f(t)$，$x = \min\!\bigl(1, 1 - (d - t)/L\bigr)$ | $1$ |
| **关系冷却（$C_h$）** | $w_{\mathrm{tier}} \cdot \sigma\!\Bigl(2.5\bigl[\ln\!\bigl(1 + \frac{s}{\tau_0 \cdot 2^{\min(r-1, 6)}}\bigr) - \ln\!\bigl(1 + \frac{\theta_c}{\tau_0}\bigr)\bigr]\Bigr)$（$\tau_0 = 600\,\mathrm{s}$；群 $\theta = \mathrm{clamp}(10\cdot\mathrm{gap}_{\mathrm{EMA}}, 30\,\mathrm{m}, 7\,\mathrm{d})$） | $3$ |
| **好奇心（$U_h$）** | 基于联系人活跃偏离预期的有界惊奇度（仅私聊与可触达目标） | $1$ |
| **分享欲望（$I_h$）** | $\max_m \bigl(\mathrm{freshness}_c \cdot \mathrm{rel}_{\mathrm{IDF}} \cdot w_{\mathrm{near}} \cdot \mathrm{novelty} \cdot 6\bigr)$，需胜过最近 $W_h = \frac{\text{日均见帖}}{\text{日均分享}}$ 条且 $\tanh(I_h/1.5) \ge 0.5$ | $1.5$ |
| **群话题拉力（$G_{\mathrm{top}}$）** | 跨会话 IDF 余弦显著度 $\ge 0.3$（半衰期 $10\,\mathrm{min}$） | $1$ |
| **群熟人拉力（$G_{\mathrm{bond}}$）** | 说话人近期与她的有回应互动强度（半衰期 $24\,\mathrm{h}$） | $3$ |
| **回避度（$V_h$）** | 被冷落 $+0.5$、负面表情 $+0.5$、明确拒绝 $+1.0$（群 $\tau = 2\,\mathrm{h}$，私聊 $8\,\mathrm{h}$；普通消息不清除） | $1$ |

### 3. 社交代价、饱和代价、退出代价与身体状态

- **社交代价（$C_{\mathrm{soc}}$）**：$0.3\,\mathrm{dist} + 0.3\,\mathrm{imp} + 0.3\,\mathrm{temp}$，包含按投入权重计量的互惠差（`hers - theirs`，避免对方回一个「1」或贴纸就抵消她的连发债务）、Dunbar 层级距离（$\mathrm{tier}/500$）、沉默时长、侵入度与 30 分钟全局发言密度。
- **无上限单边饱和代价（$C_{\mathrm{sat}}$）**：

$$C_{\mathrm{sat}} = 2\,\mathrm{rate} + 1.5\,\mathrm{cool} + 2\left(\frac{k_h}{O}\right)^2 + 1.5\,\mathrm{fail}$$

  其中 $k_h$ 为自上次有人真实回应后她单方面发送的消息/贴纸数（私聊 $O = 3$，群聊 $O = 4$；30 天半衰期，仅对方回应才归零）。由于 $(k_h/O)^2$ 不封顶，对长期不回的私聊必然收敛至沉默，不会无限追发。
- **初次私聊自适应与公平折扣**：安静的已有私聊随别处发言累积最高 $45\%$ 的 $C_{\mathrm{soc}}$ 折扣（$\tau = 6\,\mathrm{h}$）。从群里发起陌生初次私聊则按来源群学习接受率（$\mathrm{Beta}(2,4)$ 先验）、叠加 2 小时同群冷却、群内嫌弃传导与 24 小时 `PEER_FLOOD` 熔断。
- **离开代价（$C_{\mathrm{exit}}$）**：$0.3\tanh(I_h/3) + 0.3/(1 + n_h)$，在历史有效回应投入 $I_h$ 与薄证据等待价值之间权衡。
- **Borbély 双过程睡眠与饥饿（$C_{\mathrm{body}}$）**：睡眠压力 $S$ 按分钟积分（清醒 $\tau_r = 18.2\,\mathrm{h}$，睡眠 $\tau_d = 4.2\,\mathrm{h}$），对照 24 小时昼夜节律阈值（$H_0 = 0.67, L_0 = 0.17$，振幅 $0.12$），睡着时附加 $30\cdot\mathrm{depth}$ 代价且未读与义务仅在清醒时段变旧。饥饿按 $\tau = 5\,\mathrm{h}$ 增长并提升吃饭在优先级队列中的顺位。
- **DynAffect 心情与意外度回流**：效价按 OU 过程围绕基线演化（$\mu = +0.19$，$\sigma = 0.15$，$t_{1/2} = 1\,\mathrm{h}$）。发言被接住时按群内常规接话率的意外度 $(1 - \mathrm{usualUptake})$ 推升心情。

### 4. 三条硬安全不变量

1. **发送频率上限**：同一会话任意 60 秒内最多发送 **6** 条消息类动作（含文字与贴纸）。
2. **严格会话路由**：动作只作用于做出本次决定的会话；引用与表情仅能指向该会话时间线内的消息。
3. **失败不盲目重试**：失败或结果未知（`outcome_unknown`）的动作绝不自动重试。

---

## 基准对比与 A/B 消融结果

> **说明**：评测数据集、真实/合成场景集以及内部优化工作流本身不随本仓库开源。下表汇总了各机制在预注册 A/B 消融、零成本闭环普查与盲审判别中的实测结果。

| 实验 | 对照设置 | 核心实测结果 | 结论 |
|---|---|---|---|
| **意愿层替换规则** | 意愿层 vs. 手写触发规则（12 小时真模型回放） | 被找覆盖率 `99.2%` vs `99.4%`；热门群发言 `17.6` vs `26.4` 轮/群/天；主动私聊 `21` vs `0` | **上线** |
| **动作格式**（`exec-mode`） | Code Mode（`run_code` TS AST）vs. 续写 / 原生工具 / bash | 心理动作该用时使用率 **`57%` vs `22%`**（提前 2 分钟窗口 `69%` vs `33%`）；成对盲判 **`49 : 25`**（5 平）；缺陷 `3.8%` vs `3.3%`；跑题 `0%` | **上线** |
| **群聊对话弧**（`dwell`） | 按轮次进退的选项 vs. 5 分钟固定窗口 `floor` | 零成本 $\ge 2$ 轮对话段 **`33.0% → 39.1%`**（真人 `36.4%`），TVD `0.108 → 0.100`；两段 12 小时真模型窗口 `14.3% → 22.6%` 与 `17.6% → 34.5%`（真人 `35.5%`、`38.6%`） | **上线** |
| **群聊注意力过滤** | 过滤机器人、无配文媒体与 `@他人`（9.19 天普查） | 总调用 `2736 → 2664`（`-2.6%`）；睡着时被不点名群叫醒 **`16 → 8`**；10 分钟点名回应 `0.712 → 0.718` | **上线** |
| **分享欲望**（`desire`） | 自适应频道分享 vs. 基线（60 个真实时刻） | 毛病更重 `2` vs `4`（30 平）；硬塞 `0` 次；每会话每天 $\le 2$ 次（真人四分之一活跃者 p90 为 `2.12`） | **上线** |
| **初次私聊委托**（`first-dm`） | 按来源群学习 + `check_dm` / `plan_group_dm` | 防备群冒失私聊 **`33.3% (4/12) → 0.0% (0/12)`**（`check_dm` 调用 `10/12`）；友好群保持 `16.7% (1/6)` | **上线** |
| **表达多样性**（`prune-vs`） | 剪除 6 条固定开头 + `inner` 发散 + 6h 用词镜子（22×3 遍） | `distinct-2` **`0.4893 → 0.5462`**、`distinct-3` **`0.7718 → 0.8157`**；格式缺陷 `2 → 0`；单边路人感 **`71.4% → 55.3%`**（`-16.1pp`，AI 腔 `0%`）；成对 **`18 : 12 : 4`** | **上线** |
| **五环闭环整合**（`loop-v2`） | `loop-v2` vs. `loop-delegated`（40 真实时刻 + 3.78 天普查） | `think` 中 `1. 2. 3.` 做题模板率 **`77.8% (28/36) → 0.0% (0/34)`**；醒着 1–15 分钟回应份额 **`0.327`**（真人 `0.323`） | **上线** |
| **盲认人类 vs AI** | 匿名同群切片（`16` 段 Alice vs. `18` 段同群活跃真人） | AI 判别 AUC **`0.983 → 0.476`**（诡异度 AUC `0.483`、单人 AUC `0.497`，均值 `0.224` vs `0.216`） | **跨过 `< 0.60` 门槛** |

### 典型负结果（未上线）

- **零调用「看一眼」（`glance`）**：虽节省 `29%` 调用（`1298 → 916`），但群聊轮数暴跌 `67%`（`5.30 → 1.76` 轮/群/天）——**淘汰**。
- **旁观追读（`follow-reader`）**：每日消息量翻倍，在 3 个小群超过真人 p90——**淘汰**。
- **扩池轮换 48 条示例（`rot`）与高温采样（`T = 1.2`）**：`rot` 反而拉低 `distinct-2`（`0.4893 → 0.4694`）；`T = 1.2` 使格式缺陷翻倍（`2 → 5`）——**淘汰**。
- **未校准 LLM 模拟群友**：在平静聊天里对我方回合给出 `46%` 敌意反应（同期真人 `0/26`）——**停用**，改用按真人反应率校准的回应模型。

---

## 目录结构

```text
.
├── ecosystem.config.cjs        # PM2 配置（alice-runtime + alice-tagger）
├── pnpm-workspace.yaml
├── runtime/                    # TypeScript 纯核心 + 外壳运行时
│   ├── config.toml             # 非敏感环境变量映射
│   ├── .env.example            # 密钥环境变量模板
│   ├── SOUL.md                 # 人格设定
│   ├── deploy/systemd/         # systemd 加固单元文件
│   ├── src/
│   │   ├── index.ts            # 启动入口与自检（--check / --login）
│   │   ├── journal.ts          # 只追加 SQLite 事件库
│   │   ├── shell.ts            # 副作用执行、LLM 与 Telegram I/O
│   │   ├── mind/               # 纯函数状态机、组合内核、可供性表、不变量
│   │   ├── mechanisms/         # 可组合机制与压力场/意愿层
│   │   ├── speech/             # 提示词渲染、Code Mode AST 解析、媒体与反思
│   │   ├── llm/                # 发言模型、看图/口气感知、执行代理（Exa）、TTS
│   │   ├── telegram/           # @mtcute MTProto 适配、动作执行、限流闸、相册、语音通话
│   │   ├── ops/                # 操作员指令（/ops status | pause | resume | cap | stop）
│   │   └── sim/                # 确定性回放、足迹普查与平台模拟器
│   └── test/                   # Vitest 单元测试与闭环性质测试
└── services/
    └── tagger/                 # 可选本机 CPU ONNX WD-v3 看图标注服务（127.0.0.1:39100）
```

---

## 快速开始

### 环境要求

- **Node.js 22+** 与 **pnpm**
- **Telegram 用户账号**（基于 `@mtcute/node` 的 MTProto 协议，非 Bot API；前往 [my.telegram.org](https://my.telegram.org/apps) 申请 `API_ID` / `API_HASH`）
- 兼容 **OpenAI Chat Completions** 的模型接口（`LLM_API_KEY`）
- **可选**：[Exa](https://exa.ai/)（`EXA_API_KEY`，用于网页搜索）、MiniMax / ElevenLabs（`TTS_PROVIDER`，用于语音消息）、Python 3.12+ 与 `uv`（用于本机 `alice-tagger` 图像标注服务）、`pm2`

### 安装与首次登录

```bash
git clone https://github.com/LlmKira/Alice.git
cd Alice
pnpm install --frozen-lockfile

cp runtime/.env.example runtime/.env
# 编辑 runtime/.env，填入 TELEGRAM_API_ID、TELEGRAM_API_HASH、TELEGRAM_PHONE、LLM_API_KEY，
# 以及 ALICE_OPERATOR_ID（操作员的 Telegram 数字 ID）
```

首次交互登录 Telegram、校验配置并运行测试套件：

```bash
cd runtime
pnpm login          # 前台输入验证码 / 2FA，保存 session
pnpm start:check    # 校验配置、迁移 SQLite、折叠回放 Journal（不连网、不调模型）
pnpm -s check       # 类型检查 + Biome lint + 全部 Vitest 测试
```

### 生产部署（PM2）

如需启用本机看图标注（CPU ONNX，图片不出本机）：

```bash
bash services/tagger/setup.sh
```

在仓库根目录启动 PM2：

```bash
pm2 start ecosystem.config.cjs
pm2 logs alice-runtime
pm2 save
```

操作员可私聊她发送控制指令：

```text
/ops status | pause | resume | cap <美元> | stop
```

查看线上运行日志的北极星读数：

```bash
cd runtime && pnpm northstar live/alice.db
```

---

## License

[MIT](LICENSE)
