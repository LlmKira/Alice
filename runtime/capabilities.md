# 能力账本

Alice 能做什么，以这份账本为准。条目从三处来：旧系统日志里出现过的动作类型、2 月与 8 月代码注册过的动作和机制、理论/人格/北极星文档写到的行为。`test/capabilities.test.ts` 把账本和代码对齐，对不上就失败。

状态：

- **已移植**：在生产路径里，写明代码与测试。代码里引用的机制必须在生产注册表 `mechanisms` 里。
- **简化移植**：有了一部分，说明里写缺了什么。
- **刻意不做**：有证据，并有研究员同意的记录（说明里写出处）。没有同意记录的一律算未做。
- **未做**：说明里写排在哪个阶段。PLAN 没排期的写"阶段待定"。

说明一格只写代码里读不出的东西：缺什么，为什么简化或不做，一个证据路径。代码现在怎么做、开着哪些开关，以代码为准，不写在这里。

代码列的写法：`affordance:<kind>`（`mind/affordances.ts` 的登记表）、`mechanism:<name>`（`mechanisms/registry.ts` 的 `allMechanisms`）、`file:<相对 runtime/ 的路径>`。来源列里，2 月 A/B 指 `alice.db.bak-20260223-152255` / `alice.db.bak-pre-anomaly-cleanup`，7 月指 `alice.db` 的 action_log 等表（2026-07），8 月指 `alice.db` 的 journal_events（2026-08，journal-pi 运行时）；"8 月脚本"是 action.requested 里 shell 脚本中命令出现的次数。计数查询的副本在 `eval-artifacts/ledger/`（gitignore）。

## 一、对外动作

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| A01 | 发文字消息 | 日志 2 月 A/B message 87/299、7 月 message 118、8 月脚本 `irc say` 553；2 月码 send_message；论文 07 基础动作 | 已移植 | `affordance:send` | `test/telegram-acts.test.ts` `test/shell.test.ts` | |
| A02 | 引用回复某条 | 8 月脚本 `irc reply` 738；2 月码 send_message 的 replyTo | 已移植 | `affordance:send` | `test/telegram-acts.test.ts` `test/speech.test.ts` | 缺：引用本会话以外的消息（这时只发话，不带引用）。 |
| A03 | 发贴纸 | 2 月 B telegram:send_sticker 3、7 月外发 sticker 12、8 月脚本 `irc sticker` 895；2 月码 send_sticker | 已移植 | `affordance:sticker` `file:src/sticker-palette.ts` | `test/telegram-acts.test.ts` `test/sticker-palette.test.ts` | 贴纸库按平台分开（Telegram、QQ 各一份），QQ 的表情包看过一次就收进 QQ 那份。缺：8 月贴纸能带 `--ref` 引用，现在不能。 |
| A04 | 给消息点表情 | 2 月 A/B telegram:react 7/15、8 月脚本 `irc react` 38；2 月码 react | 已移植 | `affordance:react` | `test/telegram-acts.test.ts` `test/shell.test.ts` | |
| A05 | 标记已读 | 2 月 A/B telegram:mark_read 7/19、8 月脚本 `irc read` 11；2 月码 mark_read | 已移植 | `affordance:mark-read` | `test/telegram-acts.test.ts` `test/shell.test.ts` | 只在她醒来后的决定里出现。 |
| A06 | 刻意沉默 | 2 月 A/B silence 19/241、7 月 silence 115、observe 4/12/194；silence_log 2 月 A 12,897、B 13,565；论文沉默公理；SOUL 有选择性参与；product"沉默是合法行动" | 已移植 | `mechanism:pressure-production` | `test/mind-step.test.ts` `test/pressure.test.ts` `test/speech.test.ts` | |
| A07 | 退群 | 2 月 B telegram:leave_chat 4；2 月码 leave_chat | 已移植 | `affordance:leave-chat` | `test/telegram-acts.test.ts` `test/pressure.test.ts` `test/mind-settle.test.ts` `test/pressure-properties.test.ts` | 由回避驱动、不设门槛，研究员 2026-11-11 定（PLAN 行动空间条）。 |
| A08 | 加群 | 2 月码 join_chat（2 月 A 动作文本里出现 1 次）；论文 02 JOINED 边、07 入群 3 天后评估 | 简化移植 | `affordance:join-chat` | `test/telegram-acts.test.ts` `test/reach.test.ts` | 缺：只有邀请链接、不知道 id 的群，加入后那个会话是空的。加入的机会成本是手设参数（params JOIN）。证据 `eval-artifacts/social/`。 |
| A09 | 主动私聊已经聊过的人 | 论文 04 主动私聊；SOUL"想到谁了，你会主动敲他一句"；`docs/spec/north-star.md`"她是谁"；will 闭环 21 次对 0 | 已移植 | `mechanism:pressure-production` `affordance:send` | `test/pressure.test.ts` | 关系层级 150 及以外的人不会被主动联系，研究员 2026-11-11 接受。 |
| A10 | 第一次私聊群友（开新私聊） | 论文 03 P6 发现新联系人；研究员 2026-11-11"会自己私聊别人" | 简化移植 | `file:src/mechanisms/pressure/reach.ts` `file:src/mechanisms/pressure/fairness.ts` | `test/reach.test.ts` `test/first-dm.test.ts` `test/telegram-acts.test.ts` `test/telegram-errors.test.ts` `test/telegram-first-dm.test.ts` | 缺：只在群里见过、从没来往的人不算认识，不会被第一次私聊。证据 `eval-artifacts/first-dm/report.md`。 |
| A11 | 群里主动插话 | 2 月群聊开口约一半是主动的（阶段 1 覆盖率 48%）；2 月 tick_log patrol + enqueue；论文 08 自然节律 | 已移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/group-pull.ts` | `test/pressure.test.ts` `test/group-pull.test.ts` `test/group-pull-prompt.test.ts` | 缺：兴趣来源（R07）。2 月真人在话题对上、有来往的人说话时开口约是平时的两倍（`eval-artifacts/groupturn/prereg.md`）。 |
| A12 | 被点名就接话 | 2 月 is_directed；论文 03 P5 | 已移植 | `mechanism:pressure-production` `mechanism:typing-patience` | `test/pressure.test.ts` `test/mind-patience.test.ts` `test/mind-step.test.ts` | |
| A13 | 编辑自己的消息 | 2 月码 edit_message；8 月脚本 `irc edit` 5 | 已移植 | `affordance:edit` `mechanism:expression` | `test/expression.test.ts` `test/mind-invariants.test.ts` | 只量过送达，没有行为读数（`eval-artifacts/expression/prereg.md`）。 |
| A14 | 转发 | 2 月码 forward_message；8 月脚本 `irc forward` 3；论文 02 把频道内容转给感兴趣的人 | 简化移植 | `affordance:forward` `file:src/telegram/shelf.ts` | `test/reach.test.ts` `test/telegram-acts.test.ts` | 缺：提示词里不列可转的群消息。受众规则和执行器都支持，只是没有入口。 |
| A15 | 发图片、视频、相册 | 2 月码 send_media；8 月 irc photo/video、album_photos 148；ADR-260 群相册；论文 07 五种表达模态 | 简化移植 | `affordance:album-search` `affordance:album-send` `file:src/album.ts` | `test/album.test.ts` `test/qq-platform.test.ts` | 每个平台一本，只翻、只发本平台群里的图；QQ 发图是取出原消息里的图再发。缺：她自己的图库、发视频。相册只有她在群里见过的图，私聊的图不进。 |
| A16 | 发语音 | 2 月码 send_voice、llm/tts；8 月脚本 `irc voice` 1、tts.ts | 已移植 | `affordance:voice` `mechanism:voice` `file:src/llm/tts.ts` `file:src/telegram/phone-call.ts` `file:src/llm/voice-call.ts` | `test/expression.test.ts` `test/mind-invariants.test.ts` `test/speech.test.ts` `test/phone-call.test.ts` | 只量过送达（`eval-artifacts/expression/prereg.md`）。一对一语音通话是可选的，没有评测。 |
| A17 | 正在输入 | 8 月脚本 `irc typing` 433；2 月 sandbox setTyping | 已移植 | `file:src/utils/typing.ts` | `test/expression.test.ts` | 打字时长按真人手机输入速度（拼音约 39 字/分，Ruan et al. 2016、Palin et al. 2019）。回复延迟不在这里，由作息和生活决定。 |
| A18 | 发现群和频道（搜索公开群、预览、相似频道、邀请链接） | 2 月码 search_public、preview_chat、get_similar_channels、create_invite_link、exploration-guard | 简化移植 | `affordance:chat-search` `file:src/telegram/discover.ts` `file:src/mechanisms/pressure/reach.ts` | `test/reach.test.ts` `test/journal.test.ts` | 缺：相似频道、建邀请链接。 |
| A19 | 群管理（置顶、取消置顶、删消息） | 2 月码 pin_message、unpin_message、delete_message | 未做 | | | 阶段 3（行动空间，低优先） |
| A20 | 发投票 | 2 月码 send_poll | 未做 | | | 阶段 3（行动空间，低优先） |
| A21 | 改自己的资料 | 2 月码 update_profile（account） | 未做 | | | 阶段 3（行动空间，低优先） |
| A22 | 和机器人交互（按钮、inline、命令） | 2 月码 click_inline_button、inline_query、send_inline_result、get_bot_commands | 未做 | | | 阶段 3（行动空间，低优先） |
| A23 | 在频道发帖 | 论文 02 频道角色 owner/admin | 未做 | | | 阶段待定：ChatType 只有 private/group，没有频道实体 |
| A24 | 翻看、搜索聊天记录 | 2 月码 search、read_notes；8 月脚本 `irc tail` 310、`irc search` 5、`self search` 2、`self history` 1 | 简化移植 | `file:src/speech/prompt.ts` | | 缺：搜更早的聊天原文、看别的会话。`tools.recall` 只查她记下的事（R06）。阶段 3（类型化查询工具，PLAN"待研究：动作格式"）。 |
| A25 | 网络搜索、打开网页 | 2 月码 google、visit；8 月 skills google、visit；研究员 2026-11-12 要接入搜索 | 已移植 | `affordance:delegate` `mechanism:errands` `file:src/llm/errand.ts` `file:src/llm/errand-tools.ts` `file:src/llm/domains.ts` | `test/background.test.ts` `test/errand.test.ts` `test/domains.test.ts` | 证据 `eval-artifacts/executor/`：场景集送达 31/31，注入退群 0/6，每件约 0.016 美元。web 之外的领域（MCP 服务、白名单命令）由操作员用 `ALICE_EXECUTOR_DOMAINS` 配置，默认没有，没有真实运行记录。 |
| A26 | 小应用（天气、日历、倒计时、音乐、视频、热榜、一言、运势、发病文、KFC、自检） | 2 月码 use_*_app 共 11 个；8 月 cmd/skills 同名 | 简化移植 | `file:src/llm/errand-tools.ts` | `test/errand.test.ts` | 只有天气和算日子，做成执行代理的工具。其余几个在 8 月没有使用记录，不做；热榜、新闻用搜索。 |
| A27 | 跟着复读 | 2 月码 repeat_message | 已移植 | `affordance:repeat` `mechanism:expression` | `test/expression.test.ts` `test/mind-invariants.test.ts` | 缺：贴纸复读（没有贴纸的文件 id）。只量过送达（`eval-artifacts/expression/prereg.md`）。 |
| A28 | 定时、提醒 | 2 月码 schedule_task、cancel_task、printReminders；2 月 A scheduled_tasks 1 条（提醒别人关火）；8 月 self schedule | 已移植 | `mechanism:pressure-production` `affordance:intend` `file:src/mind/when.ts` | `test/expression.test.ts` `test/memory.test.ts` | 缺：取消提醒的动作；她写 `tools.fulfil` 了结。 |
| A29 | 记笔记 | 2 月码 save_note、read_notes | 未做 | | | 阶段 3（随 Diary） |
| A30 | 下载媒体、查人资料 | 8 月 `irc download` 1、`irc whois`；2 月码 printWho | 未做 | | | 阶段 3（类型化查询） |

## 二、感知（进来的事件）

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| P01 | 收消息：私聊、群聊、回复她、点名她 | 2 月 message_log、7 月 canonical message 1,445、8 月 message.received 2,170 | 已移植 | `file:src/telegram/world-adapter.ts` | `test/mind-step.test.ts` `test/shell.test.ts` | 适配器本身没有单测，由 `start:check` 覆盖。 |
| P02 | 信息流、订阅频道的新帖 | 2 月 feeds mod（60s 聚合、Bangumi）；论文 03 P6 阅读订阅频道 | 简化移植 | `file:src/telegram/world-adapter.ts` `file:src/mechanisms/pressure/reach.ts` `file:src/mechanisms/pressure/desire.ts` | `test/reach.test.ts` `test/desire.test.ts` | 缺：2 月的 RSS、Bangumi 外部源。证据 `docs/research/desire-2026-11-13.md`。 |
| P03 | 媒体内容（贴纸 emoji、图片描述、OCR、语音转写） | 2 月码 llm/vision、ocr、asr；入站 photo 2 月 A/B 1,046/1,306、7 月 204，sticker 1,393/2,440/111；SOUL"只能看到文字和语义标签（贴纸 emoji、GIF 描述）" | 已移植 | `file:src/telegram/world-adapter.ts` `file:src/speech/media.ts` `file:src/llm/perceive.ts` `file:../services/tagger/server.py` | `test/media.test.ts` `test/perceive.test.ts` | 缺：视频只看预览帧；OCR 之外的文件内容。描述提示用 2 月的英文版，研究员 2026-11-13 定。证据 `eval-artifacts/perception/`：65 张图认对角色 2/35 → 13/35。 |
| P04 | 别人给她点的表情 | 7 月 canonical reaction 1；pressure-fidelity §七-4；2 月 telegram/events.ts updateMessageReactions | 已移植 | `mechanism:pressure-production` `file:src/telegram/world-adapter.ts` | `test/world-adapter.test.ts` `test/pressure.test.ts` | userbot 只知道最近点表情的人。 |
| P05 | 被踢出群、被拉黑 | pressure-fidelity §七-4；2 月 telegram/events.ts onChatMemberUpdate | 已移植 | `mechanism:pressure-production` `file:src/telegram/world-adapter.ts` | `test/world-adapter.test.ts` `test/pressure.test.ts` `test/journal.test.ts` `test/telegram-errors.test.ts` | |
| P06 | 对方在线、正在输入、已读 | 7 月 canonical user_status 1,270、typing 221、read_history 220；PLAN 第 40、55-7 件 | 简化移植 | `file:src/telegram/world-adapter.ts` `mechanism:typing-patience` | `test/typing-patience.test.ts` | 缺：联系人在线状态 `user_status`（心跳会刷爆日志）。 |
| P07 | 醒来或隔了很久回来时，知道别处错过了什么 | 2 月码 generateOvernightBriefingHints（`mods/strategy/hint-generators.ts@feb:463-607`，静默 > 1 小时、按会话数入站与找她的条数）；ADR-53 场景 1；`eval-artifacts/absorb/omp-report.md` §2-3 | 简化移植 | `mechanism:pressure-production` `file:src/mechanisms/missed.ts` | `test/missed.test.ts` | 和 2 月不同，不写会话名和人名，因为 ADR-56 出过跨会话提人的事故。没有闭环检验。 |
| P08 | 聊天现场的客观事实：消息上的表情反应和人数、改过、转发自谁、贴纸是哪一套，群的人数、群主和管理员、禁发设置，沉在记录之前没看到的找她的话 | 2 月码 engine/act/messages.ts:186-352、timeline.ts:119-139、group-meta.ts:49-96、messages.ts getUnreadMentionIds；Gemini 补查报告第 4、5、9 条（PLAN 第 55 件第 4 项） | 简化移植 | `mechanism:scene-facts` `file:src/telegram/scene.ts` `file:src/telegram/world-adapter.ts` `file:src/mechanisms/pressure/context.ts` | `test/scene-facts.test.ts` | 缺：别人消息上的表情 Telegram 不推送，只能轮询最近有人说话的几个群。证据 `eval-artifacts/scene-facts/results.md`。 |

## 三、意愿与驱动（压力场）

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| M01 | 世界实体图（会话、联系人、线程、反应） | 论文 02；2 月 graph/* | 简化移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | 缺：信息条目 InfoItem、频道、信任与授权属性、知道/怀疑/追踪边。 |
| M02 | P1 注意力（未读） | 论文 03；2 月 p1-attention；7 月 pressure_delta P1 | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | |
| M03 | P2 信息压力 | 论文 03；2 月 p2-information | 简化移植 | `file:src/mechanisms/pressure/reach.ts` `file:src/mechanisms/pressure/desire.ts` `file:src/mechanisms/pressure/why.ts` `file:src/mechanisms/pressure/feedback.ts` | `test/reach.test.ts` `test/desire.test.ts` `test/feedback-loop.test.ts` | 缺：信息条目实体（M01）。想分享的劲只来自摆在她面前的频道帖和她自己生活、梦里的事。证据 `docs/research/desire-2026-11-13.md`：真模型 60 个时刻毛病更重 2 比 4，平局 30。 |
| M04 | P3 关系冷却 | 论文 03；2 月 p3-relationship；7 月 pressure_delta P3 | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | 只认有回应的互动，和 2 月不同，有意为之（`eval-artifacts/trigger/pressure-fidelity.md`）。 |
| M05 | P4 线程 | 论文 03；2 月 p4-thread | 简化移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | 只从"别人对她说的话没接"推出；她自己开的话题与承诺见 R04。 |
| M06 | P5 回应义务 | 论文 03；2 月 p5-response | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | PLAN 另列"P5 回应义务强度（谁的话更需要回）"待研究。 |
| M07 | P6 好奇心 | 论文 03；2 月 p6-curiosity | 简化移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | 缺：频道、信息流、新联系人这些来源（P02、A10）。 |
| M08 | P_prospect 截止压力 | 论文 03；2 月 p-prospect | 已移植 | `mechanism:pressure-production` `affordance:intend` | `test/memory.test.ts` | 只有她记下的打算才产生它。证据 `eval-artifacts/memory-eval/prereg.md`：闭环里打算 8 次、回访 1 次。 |
| M09 | 回避：被冷落、被拒绝后抬高 | ADR-217；研究员 2026-11-11 | 已移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/relation.ts` | `test/pressure.test.ts` `test/relation.test.ts` `test/pressure-properties.test.ts` | 证据 `docs/research/relationship.md`：按人记之后，线上 153 条冲着她的群消息里 14 条从不醒变成醒，0 条反过来。 |
| M10 | 反应通道：被回应、被冷落、没人听见、被拒绝 | 2 月码 rate_outcome、printPastResults、react/feedback-arc；7 月 intervention_outcome_evidence 45（cold_ignored 12、unknown_timeout 33）；8 月 group-reception.ts | 简化移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | 缺：区分温暖和冷淡。文字上的明确拒绝分类器默认关。 |
| M11 | 社交代价 C_social | 论文 04；2 月 social-cost.ts | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | |
| M12 | 饱和代价 C_sat（抗积分饱和） | 论文 04；ADR-136 | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | |
| M13 | 习惯化 | 论文 03 | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | |
| M14 | 意愿：跨会话（目标 × 可供性）按 NSV 选择，Boltzmann | 论文 04；2 月 iaus-scorer、desire；7 月 candidate_trace 167,000、decision_trace、queue_trace；8 月 iaus.ts、wake-policy.ts | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | 只决定叫醒哪个会话；在会话里做什么由模型定。 |
| M15 | 节律：间隔随外部需求伸缩 | ADR-195；论文 06 自适应 tick | 已移植 | `mechanism:pressure-production` | `test/pressure.test.ts` | |
| M16 | 四声部（勤勉、好奇、社交、谨慎） | 论文 04；2 月 voices/*；tick_log action、action_log voice、7 月 candidate_trace action_type | 简化移植 | `mechanism:pressure-production` | | 只算出来做诊断，不进提示词、不影响选择。 |
| M17 | 人格面向（16 个）与声部选举 | 论文 04；2 月 soul SET_VOICE、SET_FACET（ADR-174） | 刻意不做 | | | 研究员 2026-11-11 决定不移植（PLAN 压力场条）：2 月声部选择近乎噪声，与压力互信息 ≤ 0.012 bit。回迁需研究员同意。 |
| M18 | 人格漂移与均值回归 | 论文 04；2 月 personality_evolution_log 2 月 A/B 721/4,849、personality_snapshots 319/348、voices/beat-feedback | 未做 | | | 阶段待定（PLAN 未列；mechanism-reexamination 认为反馈臂早已断开，但没有研究员同意记录） |
| M19 | 内心冲突外显（声部相近时把犹豫交给模型） | 论文 04 | 未做 | | | 阶段待定，依赖 M16 进提示词 |
| M20 | 压力沿关系传播（拉普拉斯） | 论文 03；2 月 propagation.ts | 未做 | | | 阶段待定（mechanism-reexamination 列为不回迁，没有研究员同意记录） |
| M21 | 降级动作：代价高时只回表情 | 论文 04 | 简化移植 | `mechanism:pressure-production` `affordance:react` | | 缺：引导她只回表情的事实。把意愿的排序写进提示词（"你刚说了不少"）没有可检验的原理和数据，不做（`eval-artifacts/groupturn/prereg.md` §4）。 |
| M22 | 频率硬门（rate cap、active cooling、silence cooldown、Rank Gate、class cap） | 2 月 silence_log rate_cap 2,296/112、active_cooling 727/3,222、silence_cooldown 422/288；tick_log silent:L2 830/577 | 刻意不做 | | | 研究员：软引导、只用硬约束守不变量（PLAN 阶段 2"按研究员指出的理论撤掉"；论文"soft utility rather than a hard rate limit"）。证据：ADR-110 中 72.7% 的沉默来自 rate cap。 |
| M23 | 安全不变量：连发上限、只发往做决定的会话、失败与结果未知不重做 | 2 月 burst-limiter；7 月失败类型 provider_failed 54、telegram_failed 13 等；8 月 action.failed 560、action.outcome_unknown 7 | 已移植 | `file:src/mind/settle.ts` | `test/mind-invariants.test.ts` `test/mind-settle.test.ts` `test/shell.test.ts` | 连发上限（同一会话 60 秒 6 条）由研究员定。 |
| M24 | 等安静再开口 | 2 月回复延迟中位 16–27 秒；silence_log voi_deferred 799/200 | 已移植 | `mechanism:typing-patience` | `test/mind-patience.test.ts` | 2 月 VOI 延迟"等更多信息"只以等会话安静实现。 |
| M25 | System 1 零调用反射（skip、digest） | 2 月 engine/system1.ts；tick_log system1:skip 1,243/940/172、system1:digest 9/54/38 | 未做 | | | 单独的"看一眼"（候选组 glance）没过判定、已删：2 月 B 调用 1298 → 916，群聊轮数 5.30 → 1.76/群/天（`eval-artifacts/glance/prereg.md`）。阶段待定：要和"群里什么时候轮到她"一起重新设计（PLAN 第 63 件）。2 月的概率泄漏不移植。 |
| M26 | 三模式（巡视、专注对话、巩固）与单一焦点 | 论文 06；2 月 tick_log mode patrol 3,621/3,863/216、conversation 1,033/1,051/732、wakeup 9/18 | 未做 |  |  | 阶段待定：每会话一个状态机并行，单一焦点与抢占不适用；巩固不做成模式（R06）。 |
| M27 | 交往会话与对话弧（stay、leave、expect_reply） | 论文 03 对话弧、07 流控信号；2 月 engine/act/engagement、silence_log closing_conversation 196；8 月 episodes 6 | 简化移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/turn.ts` | `test/dwell.test.ts` `test/dwell-look.test.ts` | 不做：墙上时间超时、要她写的"等一下"标记、跨会话独占、切换代价，私聊也不做。2 月真人"是不是下一个说话人"按别人又说了几条消退，和墙上时间关系不大（`eval-artifacts/dwell/prereg.md`）。旁观时别人每说一条都叫醒她（候选组 follow）没过护栏，已删（`eval-artifacts/participation/prereg.md`）。 |
| M28 | Hawkes 节奏 | 2 月 pressure/hawkes.ts；8 月 hawkes.ts | 未做 | | | 阶段 3（PLAN：作为群聊触发已比较，无优势；私聊回复节奏另议） |
| M29 | 危机模式 | 2 月 GOAL.md 场景 6"危机处理"（后来写进 product"人类处于高压事件时减少干扰"）；2 月 silence_log crisis_mode 10/7、strategy printCrisisChannels | 刻意不做 | | | 研究员 2026-11-13 删掉替某一个人办事的场景（守夜简报、对方忙乱时少打扰、帮人维持现实关系）：她不是谁的管家（`docs/spec/north-star.md`"她是谁"）。 |
| M30 | 没做成的冲动下次还记得 | 8 月 impulse.pending 418；2 月 PendingImpulse（engine/deliberation.ts，TTL 5 分钟、最多 3 条） | 简化移植 | `mechanism:failures` | `test/failures.test.ts` `test/mind-settle.test.ts` | 只有对外动作没做成的那一半。缺 2 月那一半：想做但被压下去的冲动跨轮携带，意愿层没有"被压下的候选"这个量。行为没评测。 |
| M33 | 她自己知道上次开口的结果（"上次找他他没回""他给你点了个❤"） | 独立评审 2026-11-11（2 月码 rate_outcome、printPastResults、feedback-arc 把结果写回提示）；压力场 receptions | 已移植 | `mechanism:pressure-production` | `test/memory.test.ts` | 不分温暖和冷淡（M10）。证据 `eval-artifacts/memory-eval/prereg.md`：跨天盲审编造或记错 0 对 3。 |
| M34 | 主动开口看此刻世界上有多少人醒着（世界在线份额 A(h)） | 科研伙伴 2026-11-11 离线检验（`eval-artifacts/outreach-reception/`）：只看钟点的 g(h) 预测主动开口后 10 分钟内得到回应 AUC 0.647，按人细分无增量；她 543 次调用里 115 次在 0–7 点 | 未做 | | | 阶段待定：候选组 awake 已删（只有这一次离线检验，没有预注册，也没上过线）。要回来先预注册，再按 PLAN 第 25 件的轮换在线上测。 |
| M31 | 她自己的身体：作息（睡眠）、饥饿 | 论文 06-temporal.tex:71；2 月 circadianMultiplier（门控阈值的余弦调制）；研究员 2026-11-11 改为要做（"作息确实比较好"） | 已移植 | `mechanism:pressure-production` `affordance:bed` `file:src/mechanisms/pressure/life-body.ts` | `test/sleep.test.ts` `test/bedtime.test.ts` `test/life-body.test.ts` | 只手设时型：睡眠中点 5:30，依据 2 月真人最安静 6 小时的中点众数。证据 `docs/adr/287-sleep-and-bedtime.md`。 |
| M32 | 论文自己否决的旧设计（v1 argmax 选声部、概率情绪标签、Rank Gate 双池、压力乘法交叉项） | 论文 04、10 | 刻意不做 | | | 研究员：论文本身写明否决及原因。 |
| M35 | 她自己的生活：精力、想不想说话的底色，按时段出现的事占着她（白天回复的长尾从这里来） | PLAN"回复的快慢"；Barabási 2005 优先队列；DynAffect（Kuppens et al. 2010）；2018 年全国时间利用调查 | 简化移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/life-body.ts` `file:src/mind/noise.ts` | `test/life.test.ts` `test/life-body.test.ts` `test/noise.test.ts` | 缺：旧事浮现。证据 `docs/research/her-life.md`。 |

## 四、发言

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| S01 | 人格（SOUL.md 全文）：温柔、慈爱、少女、俏皮可爱、有主见，说对方的语言 | SOUL；L2 人格比模型重要；研究员 2026-11-12 的方向（治愈系理想型） | 已移植 | `file:SOUL.md` | `test/speech.test.ts` | 证据 `eval-artifacts/persona/prereg-1112.md`：对旧人格成对 100 比 50，护栏都不差于旧人格。 |
| S02 | 对不同亲疏的人用不同语气 | SOUL How closeness changes things；论文 05；2 月 tier；8 月 intimacy.ts | 已移植 | `mechanism:familiar` `file:src/mechanisms/familiar.ts` | `test/familiar.test.ts` | 单独的收益没测出来，留给 L4 关系区分。证据 `docs/adr/294-calibrated-familiarity.md`：编造的关系事实 72 → 0。 |
| S03 | 示例 | 论文 04 金例动态挑选；2 月 engine/act/gold-examples | 已移植 | `mechanism:palette` | `test/palette.test.ts` `test/context-v2.test.ts` | 2 月按人格面向挑，现在不按（M17）。证据 `docs/adr/282-speech-style-and-room-voice.md`。 |
| S04 | 编号时间线、长间隔、当前时间 | 论文 07 经验时间线；2 月 engine/act/timeline | 已移植 | `file:src/speech/prompt.ts` | `test/speech.test.ts` | |
| S05 | 群里的存在感（自己已经说了几条） | 2 月 engine/act/presence.ts（ADR-118） | 已移植 | `mechanism:presence` | `test/presence.test.ts` | 不取 2 月的 STOP 指令。没有 A/B。 |
| S06 | 上下文组装（按压力排序、预算分区、@ 优先） | 论文 07；2 月 storyteller、tick/prompt-builder；2 月 ADR-97 回复链逸散 | 简化移植 | `file:src/speech/prompt.ts` `file:src/mechanisms/pressure/context.ts` | `test/context-assembly.test.ts` | 缺：多实体上下文与预算分区。证据 `eval-artifacts/context-assembly/`：引用在 30 条以外时，必需行召回 0.455 → 0.955。 |
| S07 | 社交周边视觉（这个人在共享群里的近况） | 论文 07 | 简化移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/people.ts` | `test/people.test.ts` | 只在私聊里写对方在共同群里说不说话，群里不写任何人的周边事。群的内容走 R05 的受众规则。证据 `eval-artifacts/people/prereg.md`。 |
| S08 | 表达习惯的自我镜像 | 论文 07 表达熵镜像、行为自我模型；2 月 llm/self-observation | 未做 | | | 阶段 3 待议：试过的候选 habits、habits-form 没有可靠收益（L4-d habits +0.002，PLAN"已定的结论"）；只报形式特征的自我反馈要研究员同意 |
| S09 | 群体黑话与表达学习 | 论文 05 黑话、表达标签；2 月 learning note_jargon；PLAN 待议（参照 MaiBot） | 未做 | | | 阶段 3 待议：试过的候选 room-phrases、room-lines 没有可靠收益（PLAN"已定的结论"）；再做需研究员同意 |
| S10 | 跟着同一会话别人的打字方式 | PLAN 风格机制一轮；PLAN 第 42、49 件 | 已移植 | `mechanism:room-voice` | `test/room-voice.test.ts` | 证据 `docs/adr/282-speech-style-and-room-voice.md`：real-v1 开发集挑毛病 24 : 8，风格五项里四项落进同群活跃真人的 p10–p90。 |
| S11 | 知道自己能做什么、做不了什么（她那边有自己的日子，两边之间只有 Telegram，去不了谁的身边） | 场景集第 1 轮两组都编造过"我到楼下了""抬头"（`eval-artifacts/scenes/candidates.md` G1）；研究员 2026-11-12 定的身份（ADR-284） | 已移植 | `mechanism:pressure-production` | `test/body.test.ts` | 只陈述，不禁止。还剩的问题：要地址、要位置（`eval-artifacts/scenes/prereg-round2.md`）。 |
| S12 | 跟着对方的语言说话 | 研究员 2026-11-11"我们是需要支持多语言的"；ADR-260 起因是俄语群用户；相册探针里俄语私聊她 10/10 回中文 | 已移植 | `mechanism:language` | `test/language.test.ts` | 探针：没有这条事实时，俄、英、日私聊回对方语言 0/10；有了之后 10/10。生产渲染没有定量读数。 |

## 五、记忆与内在状态

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| R01 | 情绪状态（短期、长期心情，情绪事件） | 论文 02；2 月码 feel、action_log dispatch:feel 5/12；8 月 emotion.ts、emotion.episode 560；7 月 emotion_events 162（pleased 112、lonely 17、annoyed 15、tired 15、flat 3） | 简化移植 | `mechanism:pressure-production` `affordance:feel` | `test/affect.test.ts` `test/own-mood.test.ts` | 缺：长期心情、对别人情绪的观察。心情不影响意愿（B05）。证据 `docs/adr/290-mood-in-her-own-words.md`。 |
| R02 | 情绪修复（孤独、和好） | 7 月 emotion_repairs（0 行）；mechanism-reexamination P0-10 | 简化移植 | `mechanism:pressure-production` `affordance:feel` | `test/affect.test.ts` | 不写成规则状态机：场景 G4 里道歉后拒绝和解 1/15。孤独只写成事实，不替她写成心情。证据 `eval-artifacts/emotion/prereg.md`。 |
| R03 | Diary 工作记忆 | 2 月 diary mod（2 月 A 13 条；2/17、2/19 两个峰值时刻的载体）；8 月 diary.ts；Generative Agents 反思与检索 | 已移植 | `mechanism:pressure-production` | `test/reflect.test.ts` `test/diary.test.ts` | 2 月原样（她顺手写 [日记]）现在的模型只写 0–2%，对照组和那个动作已删。证据 `eval-artifacts/scenes/prereg-holdout-v2.md`：盲写留出集送达 6/10，泄露 0/10。 |
| R05 | 联系人画像与印象（印象、特质结晶、去结晶、信任、关系类型） | 论文 05；2 月码 note_impression、sense_chemistry、synthesize_portrait、update_trust、set_relation_type、belief/*；8 月 trait.observed 30、observation.extracted 257、person.ts、trait.ts | 简化移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/people.ts` `file:src/speech/reflect-people.ts` | `test/people.test.ts` | 只记具体的事，不做性格画像、特质结晶、信任分、关系类型：前沿调研（OP-Bench，2026-11-11 转述）说画像总结加重谄媚。证据 `eval-artifacts/people/prereg.md`。 |
| R04 | 她自己开、推进、了结的话题与承诺 | 2 月码 begin_topic、advance、resolve_thread、thread_review、affect_thread、note_promise、intend；action_log dispatch:advance 5/15；narrative_threads 2 月 B 148、beats 1,914；8 月 self begin-topic、threads.ts | 简化移植 | `mechanism:pressure-production` `affordance:intend` `file:src/mechanisms/pressure/recall.ts` `affordance:topic-open` `affordance:topic-advance` `affordance:topic-close` | `test/memory.test.ts` `test/topics.test.ts` `test/cross-intent.test.ts` | 缺：话题的权重、beat 类型与因果链、thread_review 的摘要、affect_thread。她自己的话题不进驱动，不会把她叫醒；要接进去，先得设计"想过就消耗"并做零成本估算。 |
| R06 | 事实记忆（记住、回忆、更新、删除、巩固、反思） | 论文 05 记忆流、检索、反思、巩固；2 月码 remember、recall_fact、update_fact、delete_fact、consolidate_facts | 简化移植 | `mechanism:pressure-production` `file:src/mechanisms/pressure/people.ts` `affordance:recall` `affordance:note-self` | `test/memory.test.ts` `test/people.test.ts` `test/memory-b.test.ts` `test/dream-ptc.test.ts` | 缺：回忆强化、删除、巩固。事后回想（巩固）和重逢时放进上一段原文，两个候选都没过使用层（`eval-artifacts/memory-eval/prereg.md`、`eval-artifacts/recall-cued/`）。 |
| R07 | 兴趣标签 | 论文 05；2 月码 tag_interest；8 月 interest.noted 38 | 未做 |  |  | 阶段：没有读者之前不做。"他喜欢 X"放进发言提示词是讨好的抓手；话题打分对上的多是虚词（`eval-artifacts/groupturn/prereg.md`）。要回来，得先有一个读它、测过的话题信号。 |
| R08 | 群画像、语言偏好 | 2 月码 update_group_profile、set_language、printLanguageOf；8 月 group-profile.ts | 刻意不做 | | `test/group-impression.test.ts` | Gemini 的补查建议继续放弃画像，用具体共同经历和互动频率体现亲疏，等过了"分不出真人和 AI"的里程碑再做；研究员 2026-11-14 认同（`~/.local/share/alice-briefs/prompt-gemini/out-feb-audit.md`，PLAN 第 55 件）。拿掉的群印象效应在噪声里（+0.01），还带着房间的口气，她跟着骂起来（`eval-artifacts/ablation-live/results.md`）。语言偏好由 S12 覆盖。 |
| R09 | 意识流（写入、浮现、强化、回收） | 论文 07b；7 月 consciousness_events 1,337 | 未做 | | | 阶段待定 |
| R10 | 查询类动作（printWho、printChatMood、printOpenTopics、printBestTimeToChat 等 11 个） | 2 月码各 mod 的 query | 未做 | | | 阶段 3：随对应的记忆以事实贡献回来，不另做查询 |
| R11 | 标记风险、记录活动 | 2 月码 flag_risk、observe_activity | 未做 | | | 阶段待定 |
| R12 | 社会事件：冒犯、越界、修复 | 8 月 social_case mod、social_events（0 行） | 简化移植 | `mechanism:pressure-production` | `test/affect.test.ts` | 冒犯不做成系统判定的事件，因为不能用词表判语义；被冒犯后的心情来自她自己的评价，修复靠她写 `tools.let_go`（B01）。证据 `eval-artifacts/emotion/prereg.md`。 |
| R13 | 内心独白，回写进上下文 | 2 月码 think()、ThoughtTimelineSource（ADR-117）；2 月 2/17 写了 211/212 轮，2/19 写了 352/504 轮；两个峰值时刻每轮都有 | 已移植 | `affordance:think` `mechanism:pressure-production` | `test/stance-conversation.test.ts` `test/group-carry.test.ts` `test/diary.test.ts` | 接着自己立场的效果测不出（0.85 对 0.87）。证据 `docs/research/memory-stream.md`。 |
| R14 | 更早的聊天的分段回顾（不调工具、不经模型） | 2 月码 memory.mod 的分段回顾（最近 120 条里跳过已显示的，按 10 分钟间隔分段、最多 5 段、只写首尾；ADR-117"金鱼记忆"）；absorb/omp-report.md §2-4 | 已移植 | `file:src/mind/step.ts` `file:src/speech/prompt.ts` | `test/earlier.test.ts` | 没做 A/B。 |

## 六、人格里写到的社交行为

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| B01 | 吵架、坚持己见、过两天悄悄改口 | SOUL"值得争的事……你温和但寸步不让地把话讲清楚"；研究员 2026-11-11"会吵架"；2 月 relationships.mod 的 reactivity 衰减（absorb/omp-report.md §2-7） | 简化移植 | `file:SOUL.md` `affordance:let-go` `file:src/llm/tone.ts` | `test/letting-go.test.ts` `test/tone.test.ts` | 缺："两天后改口"要跨天记忆（R03–R06）。机制里没有冲突状态，分不出有来有回的冲突和被嫌弃（阶段 3）。按人留下慢慢淡的不愉快测过两轮，一天之内的弧里没有增量，没进生产。 |
| B02 | 做错了道歉 | SOUL"对不起啦 是我搞错了" | 简化移植 | `file:SOUL.md` | | 只靠人格；未测。 |
| B03 | 记得承诺，在不合时宜时提起（"说好的呢"） | SOUL；论文 10 不忘承诺 | 简化移植 | `mechanism:pressure-production` `affordance:intend` | `test/memory.test.ts` | 缺：别人答应她的事只记成事实，没有截止压力。 |
| B04 | 没头没尾地分享"你看到了吗" | SOUL Sometimes initiate；论文 10 闲时分享 | 简化移植 | `mechanism:pressure-production` `affordance:forward` | `test/reach.test.ts` | 缺：她自己的兴趣（R07）。 |
| B05 | 真被伤到就不说话 | SOUL"When truly hurt: go quiet" | 简化移植 | `mechanism:pressure-production` | | 只有回避让她少开口。心情不碰意愿和等待时长，因为 ADR-95 的反刍循环来自系统反复叫醒她。是否"安静下来"没有判定（`eval-artifacts/emotion/`）。 |

## 七、北极星与运行

| # | 能力 | 来源 | 状态 | 代码 | 测试 | 说明 |
|---|---|---|---|---|---|---|
| X01 | 北极星测量：别人主动找她、温暖反应的广度、被嫌弃率 | `docs/spec/north-star.md` 线上读数"人们来找她" | 已移植 | `file:src/northstar.ts` | `test/northstar.test.ts` `test/northstar-readings.test.ts` | 只用 typed 信号。"被叫停"要读文字，CLI 不猜，`--stop-candidates` 导出交判别员离线判。K、N 的校准在 `eval-artifacts/northstar-live/`。 |
| X02 | 历史导入（关系与线程不从零开始） | PLAN 2026-11-11 决定 | 已移植 | `file:src/import-history.ts` | `test/import-history.test.ts` | 可选，上线切换时默认不运行（研究员 2026-11-11：时间久远）。 |
| X03 | 操作员控制面（查询状态、下命令、限权、关闭） | `docs/spec/system.md` 操作员；2 月 telegram/admin.ts、notify-admin | 已移植 | `file:src/ops/operator.ts` `file:src/ops/control.ts` `file:src/shell.ts` | `test/ops.test.ts` | 缺：限权（只读模式、按会话关）。 |
| X04 | 运行时自检与审计 | 2 月 audit_events 2 月 A/B 48/946、7 月 75，db/anomaly、selfcheck；8 月 audit.ts | 简化移植 | `file:src/ops/spend.ts` `file:src/ops/watch.ts` `file:src/llm/gateway.ts` | `test/ops.test.ts` | 缺：2 月 audit_events 那种逐条审计表。 |
| X05 | 第二个平台（OneBot/QQ） | 8 月 onebot/client.ts、world-adapter.ts | 简化移植 | `affordance:unsend` `file:src/platform.ts` `file:src/qq/platform.ts` `file:src/qq/world-adapter.ts` `file:src/qq/acts.ts` | `test/qq-platform.test.ts` | 平台经 `PlatformCapabilities` 声明自己支持的对外动作，不支持的自动从提示词、意愿层与 settle 收口；QQ 开启撤回（`unsend` → `delete_msg`）、关掉改消息（`edit`），贴表情仅群聊可用；群里的表情包（`sub_type` 1 的图片、商城表情）按张看一次、收进 QQ 的贴纸库，她用 `sticker` 发出去，启动时另看最多 10 个还没看过的收藏表情；相册翻、发 QQ 群里的图。缺：QQ 贴纸库存的是图片下载地址，地址过期后那张发不出去（记为没做成）；只和假的 OneBot 服务端测过，没连过真实的 SnowLuma / SnowCatQQ / NapCat / Lagrange；OneBot 的拒绝按说明文字分类。ALICE_PLATFORM=qq 才用，默认仍是 Telegram。 |
| X06 | 记下每次模型调用 | 8 月 llm.call 1,221 | 已移植 | `file:src/shell.ts` `file:src/prompt-log.ts` | `test/prompt-log.test.ts` | 缺：看图、转写、执行代理的调用不进提示词日志，只在花费账里。 |
| X07 | 复现她当时的意愿（为什么那一刻去找他） | 研究员问题 2026-11-11；时钟不写日志 | 已移植 | `file:src/journal.ts` `file:src/shell.ts` `file:src/sim/trace.ts` `file:src/mechanisms/pressure/explain.ts` `file:src/trace-log.ts` | `test/shell.test.ts` `test/trace.test.ts` | |
| X08 | 线上轮换：生产和一个候选同时挂着，按种子分组做对照 | PLAN 第 25 件，研究员 2026-11-13 批准（"你可以用 seed 决定的"） | 已移植 | `file:src/mind/rotation.ts` `file:src/shell.ts` `file:src/sim/replay.ts` `file:src/northstar.ts` | `test/rotation.test.ts` | 默认关。候选组在 `sim/will-arms.ts`。 |

## 代码清单

登记表里每种可供性、`allMechanisms` 里每个机制都要在这里出现。"生产"：是 = 在生产路径里（不带 gated 的可供性全部是；带 gated 的只在提供它的机制在 `mechanisms` 里时才是；机制在 `mechanisms` 里）；对照 = 被生产里的另一样取代、留作比较；候选 = 写好了但没过门槛。

| 代码 | 生产 | 条目 |
|---|---|---|
| `affordance:send` | 是 | A01 A02 A09 |
| `affordance:sticker` | 是 | A03 |
| `affordance:react` | 是 | A04 M21 |
| `affordance:mark-read` | 是 | A05 M25 |
| `affordance:leave-chat` | 是 | A07 |
| `affordance:join-chat` | 是 | A08 |
| `affordance:album-search` | 是 | A15 |
| `affordance:album-send` | 是 | A15 |
| `affordance:delegate` | 是 | A25 A26 |
| `affordance:chat-search` | 是 | A18 A08 |
| `affordance:forward` | 是 | A14 B04 |
| `affordance:intend` | 是 | R04 M08 B03 |
| `affordance:fulfil` | 是 | R04 B03 |
| `affordance:let-go` | 是 | B01 |
| `affordance:feel` | 是 | R01 |
| `affordance:think` | 是 | R13 |
| `affordance:topic-open` | 是 | R04 |
| `affordance:topic-advance` | 是 | R04 |
| `affordance:topic-close` | 是 | R04 |
| `affordance:bed` | 是 | M31 |
| `affordance:recall` | 是 | R10 R06 R04 |
| `affordance:note-self` | 是 | R06 |
| `affordance:dm-check` | 是 | A10 |
| `affordance:dm-defer` | 是 | A10 |
| `affordance:voice` | 是 | A16 |
| `affordance:edit` | 是 | A13 |
| `affordance:unsend` | 候选 | X05（由平台能力声明按平台提供，QQ 开启、Telegram 暂未开启） |
| `affordance:repeat` | 是 | A27 |
| `mechanism:language` | 是 | S12 |
| `mechanism:presence` | 是 | S05 |
| `mechanism:failures` | 是 | M30 M23 |
| `mechanism:missed` | 对照 | P07（单独一句的写法；生产的在 pressure-production 里） |
| `mechanism:errands` | 是 | A25 A26 |
| `mechanism:patience` | 对照 | A12 M24 |
| `mechanism:typing-patience` | 是 | P06 M24 |
| `mechanism:pressure-production` | 是 | M31 A06 A09 A11 A12 M01 M02 M04 M05 M06 M07 M09 M10 M11 M12 M13 M14 M15 M16 M21 M25 B04 B05 R01 R02 R12 R04 R06 M08 M33 B03 S11 |
| `mechanism:voice` | 是 | A16 |
| `mechanism:expression` | 是 | A13 A27 |
| `mechanism:palette` | 是 | S03 |
| `mechanism:sticker-bag` | 是 | A03 |
| `mechanism:room-voice` | 是 | S10 |
| `mechanism:scene-facts` | 是 | P08 |
| `mechanism:familiar` | 是 | S02 |
| `mechanism:closeness-calibrated` | 对照 | S02（只有校准、没有先验） |

## 旧日志里的类型

每种出现过的类型都对到上面的条目。计数依次为 2 月 A / 2 月 B / 7 月（没有的写 0）。

| 日志 | 类型 | 条数 | 条目 |
|---|---|---|---|
| action_log | message | 87 / 299 / 118 | A01 |
| action_log | silence | 19 / 241 / 115 | A06 |
| action_log | observe | 4 / 12 / 194 | A06 |
| action_log | telegram:react | 7 / 15 / 0 | A04 |
| action_log | telegram:mark_read | 7 / 19 / 0 | A05 |
| action_log | telegram:leave_chat | 0 / 4 / 0 | A07 |
| action_log | telegram:send_sticker | 0 / 3 / 0 | A03 |
| action_log | dispatch:feel | 5 / 12 / 0 | R01 |
| action_log | dispatch:advance | 5 / 15 / 0 | R04 |
| action_log | llm_failed、provider_failed、telegram_failed、validation_failed、internal | 1 / 280 / 75 | M23 |
| action_log | command_misuse、script_failed | 0 / 0 / 14 | M23 |
| action_log.voice、tick_log.action | diligence、curiosity、sociability、caution | 各表皆有 | M16 |
| tick_log.gate_verdict | enqueue | 166 / 1,017 / 519 | M14 |
| tick_log.gate_verdict | silent:L1_LOW_PRESSURE、silent:L3_STRATEGIC | 2,064 / 2,335 / 29 | A06 |
| tick_log.gate_verdict | silent:L2_ACTIVE_COOLING | 830 / 577 / 8 | M22 |
| tick_log.gate_verdict | silent:L4_DEFERRED | 342 / 0 / 200 | M24 |
| tick_log.gate_verdict | system1:skip、system1:digest | 1,252 / 994 / 210 | M25 |
| tick_log.mode | patrol、conversation、wakeup | 4,654 / 4,923 / 966 | M26 |
| silence_log.reason | all_candidates_negative | 8,447 / 9,936 / 0 | A06 |
| silence_log.reason | rate_cap、active_cooling、silence_cooldown | 3,445 / 3,622 / 0 | M22 |
| silence_log.reason | voi_deferred | 799 / 0 / 200 | M24 |
| silence_log.reason | closing_conversation | 196 / 0 / 0 | M27 |
| silence_log.reason | crisis_mode | 10 / 7 / 0 | M29 |
| silence_log.reason | candidate_pool_empty:channel_action_scope、post_wakeup_recovery | 0 / 0 / 37 | M14 |
| narrative_threads、narrative_beats | engagement、observation、prudence、connection 等 10 种 beat | 线程 142 / 148 / 2；beat 487 / 1,914 / 0 | R04 |
| personality_evolution_log | 四个维度 × beat、decay、outcome | 721 / 4,849 / 516 | M18 |
| diary_entries | — | 13 / 0 / 0 | R03 |
| scheduled_tasks | at | 1 / 0 / 0 | A28 |
| mod_states | consolidation、diary、feeds、learning、memory、observer、pressure、relationships、scheduler、soul、strategy、threads；7 月另有 channel、consciousness、episode、social_case | 13 / 12 / 16 | R06 R03 P02 S09 S04 R05 M14 A28 M17 M29 R04 A23 R09 M27 R12 |
| candidate_trace（7 月） | curiosity、diligence、sociability、caution | 0 / 0 / 167,000 | M14 |
| decision_trace、queue_trace、tick_trace（7 月） | evolve/act、accepted/executed/dropped | 0 / 0 / 1,482 | M14 |
| pressure_delta（7 月） | P1–P6、API、API_peak | 0 / 0 / 10,920 | M02 M04 M05 M06 M07 M15 |
| consciousness_events（7 月） | evolve:enqueue、evolve:silence、evolve:pressure、evolve:tier | 0 / 0 / 1,161 | R09 |
| consciousness_events（7 月） | tool:sent、tool:sticker、tool:react、tool:internal | 0 / 0 / 176 | A01 A03 A04 |
| emotion_events（7 月） | pleased、lonely、annoyed、tired、flat | 0 / 0 / 162 | R01 |
| episodes（7 月） | silence、空 | 0 / 0 / 6 | M27 |
| intervention_outcome_evidence（7 月） | cold_ignored、unknown_timeout | 0 / 0 / 45 | M10 |
| focus_transition_shadow、focus_transition_intent（7 月） | observe_shadow、switch_then_send_shadow、switch_request_blocked | 0 / 0 / 20 | M14 |
| canonical_events（7 月） | message | 0 / 0 / 1,445 | P01 |
| canonical_events（7 月） | user_status、typing、read_history | 0 / 0 / 1,711 | P06 |
| canonical_events（7 月） | reaction | 0 / 0 / 1 | P04 |
| album_photos（7 月） | photo | 0 / 0 / 148 | A15 |
| fact_mutation（7 月） | diagnostic/none | 0 / 0 / 516 | X04 |
| journal_events（8 月） | message.received | 2,170 | P01 |
| journal_events（8 月） | action.requested、action.completed | 909、348 | A01 |
| journal_events（8 月） | action.failed、action.outcome_unknown | 560、7 | M23 |
| journal_events（8 月） | emotion.episode | 560 | R01 |
| journal_events（8 月） | impulse.pending | 418 | M30 |
| journal_events（8 月） | observation.extracted、trait.observed | 257、30 | R05 |
| journal_events（8 月） | interest.noted | 38 | R07 |
| journal_events（8 月） | wake.requested、turn.completed | 178、337 | M14 |
| journal_events（8 月） | llm.call | 1,221 | X06 |
| 8 月脚本 | irc say、reply、sticker、react、read、typing、tail、search、edit、forward、voice、download | 553、738、895、38、11、433、310、5、5、3、1、1 | A01 A02 A03 A04 A05 A17 A24 A24 A13 A14 A16 A30 |
| 8 月脚本 | self search、self history | 2、1 | A24 |
| 8 月脚本 | python3 / sqlite3 读库、find 一类探查 | `python3` 出现 234 次 | — 缺陷，不是能力：coding agent 提示带偏，PLAN 阶段 4 已删 |

## 没有列成条目的旧代码

这些是运行或开发用的基础设施，不是她在世界里的行为：2 月 `diagnostics/*`、`eval/*`、`db/*`、`core/sandbox*`、`core/mod-loader`、`core/dispatcher`、`llm/resilience`、`llm/group-cache`、`llm/media-cache`、`telegram/bootstrap`、`telegram/mapper`；8 月 `pi/*`、`core/shell-executor`、`skills/backends/*`、`agent-server`、`journal-mirror`、`replay/*`、Go CLI。压力场公式层面排除的 2 月缺陷（AdaptiveKappa、goldilocks 乘法项、IAUS 乘法补偿、Hawkes 归一化等）记在 `eval-artifacts/trigger/pressure-fidelity.md`，它们是实现取舍，能力本身见 M01–M15。

改动规则：加一种可供性或机制，同时在这里加条目并写进代码清单；把一项从未做改成已移植，要附上测试。
