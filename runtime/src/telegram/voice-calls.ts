/**
 * 一对一语音通话（capabilities 里的 Telegram 通话）：每接通一个电话就开一段通话，挂断或断线就结束它。
 * 通话里的每句话：用人格、通话口吻和最近的聊天拼成系统提示，经同一个网关问发言模型。
 */
import type { TelegramClient } from "@mtcute/node";
import { chatTokens, type Gateway } from "../llm/gateway.js";
import { transcribeVoice } from "../llm/perceive.js";
import type { SPEECH_MODELS, SpeechModelName } from "../llm/speech-model.js";
import { synthesizeSpeech, type TtsConfig } from "../llm/tts.js";
import { CALL_TONE, VoiceCallSession, type VoiceTurn } from "../llm/voice-call.js";
import type { AliceState } from "../mind/state.js";
import { createLogger } from "../utils/logger.js";
import { createMtcuteCallClient, TelegramPhoneCalls } from "./phone-call.js";

const log = createLogger("runtime");

interface VoiceCallSetup {
  client: TelegramClient;
  gateway: Gateway;
  tts: TtsConfig;
  callModel: (typeof SPEECH_MODELS)[SpeechModelName];
  persona: string;
  allowUser: (uid: number) => boolean;
  chat: (uid: number) => AliceState["chats"][string] | undefined;
}

/** 一对一语音通话：每接通一个电话就开一段通话，挂断或断线就结束它。 */
export function createVoiceCalls(setup: VoiceCallSetup): TelegramPhoneCalls {
  const { gateway, tts } = setup;
  const sessions = new Map<number, VoiceCallSession>();
  const voiceCalls = new TelegramPhoneCalls({
    client: createMtcuteCallClient(setup.client),
    allowUser: setup.allowUser,
    onConnected: (uid) => {
      const chat = setup.chat(uid);
      const recent = (chat?.timeline ?? [])
        .slice(-8)
        .map((e) => `${e.sender ? e.sender.name : "Alice"}: ${e.text ?? `[${e.contentType}]`}`)
        .join("\n");
      const session = new VoiceCallSession({
        asr: (ogg) => transcribeVoice(gateway, ogg),
        reply: callReply(gateway, setup.callModel, setup.persona, recent),
        speak: (text, signal) => synthesizeSpeech(tts, text, { signal, charge: gateway.charge }),
        sendFrame: (pcm, signal) => voiceCalls.sendAudioFrames(uid, pcm, { signal }),
        onEnd: (reason) => {
          sessions.delete(uid);
          if (reason === "hangup") void voiceCalls.hangup(uid).catch(() => {});
        },
        onError: (error) => log.warn("Voice call turn failed", { userId: uid, error }),
      });
      sessions.set(uid, session);
      void session.start();
    },
    onAudio: (uid, pcm) => sessions.get(uid)?.handleAudio(pcm),
    onClosed: (uid, reason) => {
      const s = sessions.get(uid);
      sessions.delete(uid);
      s?.dispose(reason);
    },
    onError: (error) => log.warn("Phone call transport failed", { error }),
    log: (line) => log.info(line),
  });
  return voiceCalls;
}

/** 在通话里回一句：用人格、通话口吻和最近的聊天拼成系统提示，附上最近 12 轮通话内容。 */
function callReply(
  gateway: Gateway,
  callModel: (typeof SPEECH_MODELS)[SpeechModelName],
  persona: string,
  recent: string,
): (history: readonly VoiceTurn[], callerText: string) => Promise<string> {
  return async (history, callerText) => {
    const { body } = await gateway.post<{
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    }>({
      kind: "speech",
      model: callModel.id,
      path: "/chat/completions",
      timeoutMs: 30_000,
      attempts: 2,
      tokens: chatTokens,
      body: {
        model: callModel.id,
        ...callModel.extra,
        max_tokens: 200 + callModel.thinking,
        messages: [
          {
            role: "system",
            content: `${persona.trim()}\n\n${CALL_TONE}${recent ? `\n\n最近聊天：\n${recent}` : ""}`,
          },
          ...history.slice(-12).map((t) => ({
            role: t.role === "caller" ? "user" : "assistant",
            content: t.text,
          })),
          ...(history.at(-1)?.role === "caller"
            ? []
            : [{ role: "user" as const, content: callerText }]),
        ],
      },
    });
    return body.choices?.[0]?.message?.content?.trim() ?? "";
  };
}
