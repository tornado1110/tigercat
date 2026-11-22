import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { parseFeishuMessage } from "../../src/feishu.js";
import { ImChannel } from "../../src/im-channel.js";
import { FakeTimeRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";

const access = { botOpenId: "ou_bot", users: new Set(["ou_owner"]), groups: new Set(["oc_group"]) };

function event(id: string, text: string, chat: "p2p" | "group" = "p2p", rootId?: string) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: {
      message_id: id,
      chat_id: chat === "group" ? "oc_group" : "oc_private",
      chat_type: chat,
      create_time: "1",
      message_type: "text",
      content: JSON.stringify({ text }),
      root_id: rootId,
      mentions: chat === "group" ? [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "TigerCat" }] : [],
    },
  };
}

describe("native Feishu IM channel", () => {
  it("admits authorized text and keeps group topic replies on the original route", () => {
    const first = event("om_first", "@_user_1 修复测试", "group");
    const reply = event("om_reply", "@_user_1 继续", "group", "om_first");
    expect(parseFeishuMessage(first, access)).toMatchObject({ text: "修复测试", replyTarget: { messageId: "om_first", inThread: "true" } });
    expect(parseFeishuMessage(first, access)?.conversation).toBe(parseFeishuMessage(reply, access)?.conversation);
    expect(parseFeishuMessage(first, access)?.conversation).not.toBe(parseFeishuMessage(event("other", "private"), access)?.conversation);

    expect(parseFeishuMessage({ ...first, sender: { ...first.sender, sender_type: "app" } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, sender: { ...first.sender, sender_id: { open_id: "ou_other" } } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, message: { ...first.message, chat_id: "oc_other" } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, message: { ...first.message, mentions: [] } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, message: { ...first.message, message_type: "file" } }, access)).toBeUndefined();
  });

  it("deduplicates receipts, serializes a conversation, and replies to the matching messages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tigercat-feishu-test-"));
    const store = SqliteStore.open(path.join(root, "state.sqlite"));
    const clock = new SystemClock();
    const config = defaultConfig();
    config.runtimes = [{ name: "stub", command: "fake", args: [], env: {}, permission: "deny", tags: [], description: "test" }];
    const engine = new Engine({ store, clock, config, factory: new FakeTimeRuntimeFactory(clock, 5), workspaceRoot: root });
    const sent = new Map<string, string>();
    const channel = new ImChannel(engine, "feishu:test", "stub", {
      send: async ({ target, text }) => {
        expect(sent.has(target.messageId!)).toBe(false);
        sent.set(target.messageId!, text);
        return { disposition: "delivered", reason: "test accepted it" };
      },
    }, (message) => { throw new Error(message); });
    try {
      await engine.start();
      await channel.start();
      const first = parseFeishuMessage(event("om_one", "first task"), access)!;
      const second = parseFeishuMessage(event("om_two", "follow-up"), access)!;
      const group = parseFeishuMessage(event("om_group", "@_user_1 group task", "group"), access)!;
      await Promise.all([channel.receive(first), channel.receive(first), channel.receive(group), channel.receive(second)]);
      const workers = await engine.list();
      expect(workers).toHaveLength(2);
      const privateWorker = workers.find(({ id }) => sent.get("om_one")?.includes(id))!;
      expect(sent.get("om_one")).toContain("done first task");
      expect(sent.get("om_two")).toContain(`${privateWorker.id} finished: done follow-up`);
      expect(sent.get("om_group")).toContain("done group task");
      expect(sent.get("om_group")).not.toContain(privateWorker.id);

      await engine.kill(privateWorker.id);
      await channel.receive(parseFeishuMessage(event("om_three", "replace worker"), access)!);
      expect(sent.get("om_three")).toContain("done replace worker");
      expect(sent.get("om_three")).not.toContain(privateWorker.id);
      expect((await store.listDeliveries()).map((delivery) => delivery.status)).toEqual(Array(4).fill("delivered"));

      const reconnect = new ImChannel(engine, "feishu:test", "stub", {
        send: async () => { throw new Error("unexpected replay"); },
      }, (message) => { throw new Error(message); });
      try {
        await reconnect.start();
        await reconnect.receive(first);
        expect((await engine.list())).toHaveLength(3);
        expect(await store.listDeliveries()).toHaveLength(4);
      } finally {
        await reconnect.stop();
      }
    } finally {
      await channel.stop();
      await engine.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
