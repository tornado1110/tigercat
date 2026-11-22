import { createHash } from "node:crypto";
import type { EventHandles, Logger } from "@larksuiteoapi/node-sdk";
import { TigerError } from "./errors.js";
import { serveImChannel, type ImChannelHostOptions, type ImMessage } from "./im-channel.js";

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
  const inThread = message.chat_type === "group";
  const mentions = (message.mentions ?? []).filter((mention) => mention.id?.open_id === access.botOpenId && mention.key);
  if (inThread ? !access.groups.has(message.chat_id) || mentions.length === 0 : message.chat_type !== "p2p") return;

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
  const topic = inThread ? message.root_id || message.parent_id || message.thread_id || message.message_id : user;
  return {
    id: message.message_id,
    conversation: JSON.stringify([message.chat_id, topic]),
    replyTarget: { messageId: message.message_id, inThread: String(inThread) },
    text,
  };
}

function idSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export async function serveFeishu(options: ImChannelHostOptions): Promise<void> {
  const appId = process.env.TIGERCAT_FEISHU_APP_ID?.trim();
  const appSecret = process.env.TIGERCAT_FEISHU_APP_SECRET?.trim();
  const botOpenId = process.env.TIGERCAT_FEISHU_BOT_OPEN_ID?.trim();
  const users = idSet(process.env.TIGERCAT_FEISHU_ALLOWED_USERS);
  const groups = idSet(process.env.TIGERCAT_FEISHU_ALLOWED_CHATS);
  if (!appId || !/^[a-z0-9_]+$/i.test(appId) || !appSecret || !botOpenId || users.size === 0) {
    throw new TigerError("invalid_args", "Feishu requires TIGERCAT_FEISHU_APP_ID, TIGERCAT_FEISHU_APP_SECRET, TIGERCAT_FEISHU_BOT_OPEN_ID and TIGERCAT_FEISHU_ALLOWED_USERS");
  }

  const { Client, EventDispatcher, WSClient, defaultHttpInstance } = await import("@larksuiteoapi/node-sdk");
  defaultHttpInstance.defaults.timeout = 15_000;
  const credentials = { appId, appSecret, logger: sdkLogger };
  const client = new Client(credentials);
  const access = { botOpenId, users, groups };
  await serveImChannel(options, {
    source: `feishu:${appId}`,
    databaseName: `feishu-${appId}.sqlite`,
    secrets: { TIGERCAT_FEISHU_APP_SECRET: appSecret },
    transport: {
      send: async ({ eventId, target, text }) => {
        const characters = Array.from(text);
        const body = characters.length > 9_000 ? characters.slice(0, 9_000).join("") + "\n…（结果已截断）" : text;
        const uuid = createHash("sha256").update(eventId).digest("hex").slice(0, 32);
        try {
          const response = await client.im.v1.message.reply({
            path: { message_id: target.messageId! },
            data: { content: JSON.stringify({ text: body }), msg_type: "text", reply_in_thread: target.inThread === "true", uuid },
          });
          if (response.code === 0) return { disposition: "delivered", reason: "Feishu accepted the reply" };
        } catch {
          // A disconnected response cannot prove the bot did not send it.
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
            onReady: () => options.report("Feishu WebSocket connected."),
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
