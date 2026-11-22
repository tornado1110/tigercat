import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { feishuReplyCard, parseFeishuMessage } from "../../src/feishu.js";
import { ImChannel } from "../../src/im-channel.js";
import { FakeTimeRuntimeFactory, ProcessRuntimeFactory } from "../../src/runtime.js";
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
  it("admits authorized text and folds all topics into the group conversation", () => {
    const first = event("om_first", "@_user_1 修复测试", "group");
    const reply = event("om_reply", "@_user_1 继续", "group", "om_first");
    expect(parseFeishuMessage(first, access)).toMatchObject({ text: "修复测试", replyTarget: { messageId: "om_first", inThread: "false" } });
    expect(parseFeishuMessage(first, access)?.conversation).toBe(parseFeishuMessage(reply, access)?.conversation);
    expect(parseFeishuMessage(first, access)?.conversation).toBe(parseFeishuMessage(event("other", "@_user_1 more", "group"), access)?.conversation);
    expect(parseFeishuMessage(first, access)?.conversation).not.toBe(parseFeishuMessage(event("other", "private"), access)?.conversation);

    expect(parseFeishuMessage({ ...first, sender: { ...first.sender, sender_type: "app" } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, sender: { ...first.sender, sender_id: { open_id: "ou_other" } } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, message: { ...first.message, chat_id: "oc_other" } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, message: { ...first.message, mentions: [] } }, access)).toBeUndefined();
    expect(parseFeishuMessage({ ...first, message: { ...first.message, message_type: "file" } }, access)).toBeUndefined();
  });

  it.each([
    { followup: "correction", ok: true, result: "original + correction" },
    { followup: "cancel", ok: false, result: "本轮已取消" },
  ])("delivers one answer to the opener after a cold-start ACP follow-up ($followup)", async ({ followup, ok, result }) => {
    const root = await mkdtemp(path.join(tmpdir(), "tigercat-steer-"));
    const store = SqliteStore.open(path.join(root, "state.sqlite"));
    const config = defaultConfig();
    config.runtimes = [{
      name: "stub", command: process.execPath, args: [path.resolve("test/stub-agent.ts")],
      env: { TIGERCAT_STUB_SCENARIO: "steer" }, tags: [], permission: "deny", description: "steerable ACP peer",
    }];
    const engine = new Engine({ store, clock: new SystemClock(), config, factory: new ProcessRuntimeFactory(), workspaceRoot: root });
    const replies: Array<[string, string]> = [];
    const statuses: string[] = [];
    const channel = new ImChannel(engine, "feishu:test", "stub", {
      send: async ({ target, text, identity }) => {
        expect(identity).toMatchObject({ runtime: "stub", model: "test-model" });
        const card = JSON.parse(feishuReplyCard(text, identity));
        expect(card.body.elements[0]).toEqual({ tag: "markdown", content: text });
        expect(card.body.elements[1].text.content).toBe("stub · test-model");
        replies.push([target.messageId!, text]);
        return { disposition: "delivered", reason: "accepted" };
      },
    }, (message) => { throw new Error(message); }, {
      working: async ({ messageId }) => {
        statuses.push(`${messageId}:working`);
        return async (ok) => { statuses.push(`${messageId}:${ok}`); };
      },
    });
    try {
      await engine.start();
      await channel.start();
      const first = parseFeishuMessage(event("one", "original"), access)!;
      const second = parseFeishuMessage(event("two", followup), access)!;
      await Promise.all([channel.receive(first), channel.receive(second), channel.receive(second)]);
      expect(statuses.slice(0, 2)).toEqual(["one:working", "two:working"]);
      expect(statuses.slice(2).sort()).toEqual([`one:${ok}`, `two:${ok}`]);
      expect(replies).toEqual([["one", expect.stringContaining(result)]]);
      expect(await engine.list()).toHaveLength(1);
      expect(await store.listDeliveries()).toHaveLength(1);
    } finally {
      await channel.stop();
      await engine.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates receipts, falls back to sequential turns on an unsupported runtime, and replies to the matching messages", async () => {
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
    }, (message) => { throw new Error(message); }, { working: async () => async () => {} });
    try {
      await engine.start();
      await channel.start();
      const first = parseFeishuMessage(event("om_one", "first task"), access)!;
      const second = parseFeishuMessage(event("om_two", "follow-up"), access)!;
      const group = parseFeishuMessage(event("om_group", "@_user_1 group task", "group"), access)!;
      await Promise.all([channel.receive(first), channel.receive(first), channel.receive(group), channel.receive(second)]);
      const workers = await engine.list();
      expect(workers).toHaveLength(2);
      const deliveries = await store.listDeliveries();
      const privateWorker = deliveries.find((d) => d.eventId.endsWith(":om_one"))!.workerId;
      expect(sent.get("om_one")).toContain("done first task");
      expect(sent.get("om_two")).toBe("done follow-up");
      expect(deliveries.find((d) => d.eventId.endsWith(":om_two"))!.workerId).toBe(privateWorker);
      expect(sent.get("om_group")).toContain("done group task");
      expect(deliveries.find((d) => d.eventId.endsWith(":om_group"))!.workerId).not.toBe(privateWorker);

      await engine.kill(privateWorker);
      await channel.receive(parseFeishuMessage(event("om_three", "replace worker"), access)!);
      expect(sent.get("om_three")).toContain("done replace worker");
      expect((await store.listDeliveries()).find((d) => d.eventId.endsWith(":om_three"))!.workerId).not.toBe(privateWorker);
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
