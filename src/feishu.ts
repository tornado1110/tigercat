import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configPath } from "./config.js";
import { bindingFile, loadOrRegisterFeishu } from "./feishu-binding.js";
import type { EventHandles, Logger } from "@larksuiteoapi/node-sdk";
import { TigerError } from "./errors.js";
import { serveImChannel, type ImChannelHostOptions, type ImMessage } from "./im-channel.js";

import type { ReplyIdentity } from "./store.js";

type MessageEvent = Parameters<NonNullable<EventHandles["im.message.receive_v1"]>>[0];

// SDK errors may contain raw request configuration. Report the channel's
// own connection and delivery status without logging SDK payloads.
const discardSdkLog = () => undefined;
const sdkLogger: Logger = {
  error: discardSdkLog,
  warn: discardSdkLog,
  info: discardSdkLog,
  debug: discardSdkLog,
  trace: discardSdkLog,
};

interface FeishuAccess {
  botOpenId: string;
  users: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

export function parseFeishuMessage(event: MessageEvent, access: FeishuAccess): ImMessage | undefined {
  const { sender, message } = event;
  const user = sender?.sender_id?.open_id;
  if (sender?.sender_type !== "user" || !user || !access.users.has(user)) return;
  if (message?.message_type !== "text" || !message.message_id || !message.chat_id) return;
  const group = message.chat_type === "group";
  const mentions = (message.mentions ?? []).filter((mention) => mention.id?.open_id === access.botOpenId && mention.key);
  if (group ? !access.groups.has(message.chat_id) || mentions.length === 0 : message.chat_type !== "p2p") return;

  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return;
  }
  if (!content || typeof content !== "object" || !("text" in content) || typeof content.text !== "string") return;
  let text = content.text;
  for (const mention of mentions) text = text.replaceAll(mention.key, "");
  text = text.trim();
  if (!text) return;
  return {
    id: message.message_id,
    conversation: JSON.stringify(group ? [message.chat_id] : [message.chat_id, user]),
    replyTarget: { messageId: message.message_id, inThread: "false" },
    text,
  };
}

export function feishuReplyCard(text: string, identity?: ReplyIdentity): string {
  const elements: object[] = [{ tag: "markdown", content: text }];
  if (identity) {
    const runtime = identity.runtime === "codex" ? "Codex" : identity.runtime === "claude-code" ? "Claude Code" : identity.runtime;
    const labels = [identity.workspace && `工作区 ${identity.workspace}`, runtime, identity.model, identity.effort]
      .filter((label): label is string => Boolean(label)).map((label) => label.replace(/\s+/g, " ").trim().slice(0, 80));
    elements.push({ tag: "div", text: { tag: "plain_text", content: labels.join(" · "), text_size: "notation", text_color: "grey" } });
  }
  return JSON.stringify({ schema: "2.0", config: { wide_screen_mode: true }, body: { elements } });
}

function idSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export async function serveFeishu(options: ImChannelHostOptions): Promise<void> {
  let appId = process.env.TIGERCAT_FEISHU_APP_ID?.trim();
  let appSecret = process.env.TIGERCAT_FEISHU_APP_SECRET?.trim();
  let botOpenId = process.env.TIGERCAT_FEISHU_BOT_OPEN_ID?.trim();
  const users = idSet(process.env.TIGERCAT_FEISHU_ALLOWED_USERS);
  const groups = idSet(process.env.TIGERCAT_FEISHU_ALLOWED_CHATS);
  const { Client, Domain, EventDispatcher, WSClient, defaultHttpInstance, registerApp } = await import("@larksuiteoapi/node-sdk");
  defaultHttpInstance.defaults.timeout = 15_000;
  let domain = Domain.Feishu;
  const managed = !appId && !appSecret && !botOpenId;
  if (managed) {
    const profile = path.resolve(configPath(options.configFile));
    const binding = await loadOrRegisterFeishu(bindingFile(), profile, registerApp, options.report);
    appId = binding.appId;
    appSecret = binding.appSecret;
    if (binding.owner) users.add(binding.owner);
    domain = binding.brand === "lark" ? Domain.Lark : Domain.Feishu;
  }
  if (!appId || !/^[a-z0-9_]+$/i.test(appId) || !appSecret || (!managed && !botOpenId) || users.size === 0) {
    throw new TigerError("invalid_args", managed
      ? "飞书未返回创建者 Open ID。请将你在此应用的 Open ID 配置到 TIGERCAT_FEISHU_ALLOWED_USERS，再运行 tigercat feishu connect 复用已保存的应用。"
      : "Feishu requires TIGERCAT_FEISHU_APP_ID, TIGERCAT_FEISHU_APP_SECRET, TIGERCAT_FEISHU_BOT_OPEN_ID and TIGERCAT_FEISHU_ALLOWED_USERS");
  }
  const credentials = { appId, appSecret, domain, logger: sdkLogger };
  const client = new Client(credentials);
  if (!botOpenId) {
    for (const wait of [0, 2_000, 4_000, 8_000]) {
      if (wait) await delay(wait);
      const info = await client.request<{ code: number; bot?: { open_id?: string } }>({ url: "/open-apis/bot/v3/info", method: "GET" }).catch(() => undefined);
      if (info?.code === 0 && info.bot?.open_id) {
        botOpenId = info.bot.open_id;
        break;
      }
    }
    if (!botOpenId) throw new TigerError("feishu_identity", "已保存授权，飞书暂未返回机器人身份。请重新运行 tigercat feishu connect。");
  }
  const access = { botOpenId, users, groups };
  await serveImChannel(options, {
    localWorkerDefault: managed,
    source: `feishu:${appId}`,
    databaseName: `feishu-${appId}.sqlite`,
    secrets: { TIGERCAT_FEISHU_APP_SECRET: appSecret },
    liveTurns: {
      working: async ({ messageId }) => {
        const path = { message_id: messageId! };
        const reactions = client.im.v1.messageReaction;
        const add = async (emoji: string) => {
          try {
            const response = await reactions.create({ path, data: { reaction_type: { emoji_type: emoji } } });
            if (response.code === 0) return response.data?.reaction_id;
          } catch { /* SDK errors may contain credentials. */ }
          options.report("Feishu could not add the message reaction.");
        };
        const typing = await add("Typing");
        return async (success) => {
          if (typing) {
            const removed = await reactions.delete({ path: { ...path, reaction_id: typing } }).catch(() => undefined);
            if (removed?.code !== 0) options.report("Feishu could not remove the typing reaction.");
          }
          await add(success ? "DONE" : "CrossMark");
        };
      },
    },
    transport: {
      send: async ({ eventId, target, text, identity }) => {
        const characters = Array.from(text);
        const body = characters.length > 9_000 ? characters.slice(0, 9_000).join("") + "\n…（结果已截断）" : text;
        const uuid = createHash("sha256").update(eventId).digest("hex").slice(0, 32);
        const reply = (type: "interactive" | "text", content: string) => client.im.v1.message.reply({
          path: { message_id: target.messageId! },
          data: { content, msg_type: type, reply_in_thread: target.inThread === "true", uuid },
        });
        // Only a confirmed card rejection can fall back without risking a duplicate.
        let code: unknown;
        try {
          code = (await reply("interactive", feishuReplyCard(body, identity))).code;
        } catch (error) {
          code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
        }
        if (code === 0) return { disposition: "delivered", reason: "Feishu accepted the card" };
        if (typeof code === "number" && code > 0) {
          try {
            const fallback = await reply("text", JSON.stringify({ text: body }));
            if (fallback.code === 0) return { disposition: "delivered", reason: "Feishu accepted the text fallback" };
          } catch { /* Delivery is unconfirmed. */ }
        }
        return { disposition: "unknown", reason: "Feishu did not confirm the reply" };
      },
    },
    connect: async (receive, signal) => {
      let socket: InstanceType<typeof WSClient> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          socket = new WSClient({
            ...credentials,
            handshakeTimeoutMs: 15_000,
            onReady: () => {
              options.report("Feishu WebSocket connected.");
              if (managed) options.report(`打开机器人私聊：https://applink.${domain === Domain.Lark ? "larksuite.com" : "feishu.cn"}/client/bot/open?appId=${appId}`);
            },
            onError: () => reject(new TigerError("feishu_connection", "Feishu WebSocket connection failed. Check the bot credentials and event subscription.")),
          });
          const dispatcher = new EventDispatcher({ logger: sdkLogger });
          dispatcher.register({
            "im.message.receive_v1": (event) => {
              if (signal.aborted || (event.app_id && event.app_id !== appId)) return;
              const message = parseFeishuMessage(event, access);
              if (message) receive(message);
            },
          });
          void socket.start({ eventDispatcher: dispatcher }).catch(() => {
            reject(new TigerError("feishu_connection", "Feishu WebSocket could not start."));
          });
        });
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        socket?.close({ force: true });
      }
    },
  });
}
