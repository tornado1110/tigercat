import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER_VERSION, defaultConfig } from "../../src/config.js";
import { admit } from "../../src/filter.js";
import { startHarness } from "../harness/engine.js";

const policy = defaultConfig().filter;

function judge(text: string, extra?: { has_subscriber?: boolean; source?: string; kind?: string; is_bot?: boolean; thread_id?: string }) {
  return admit(
    {
      source: extra?.source ?? "feishu",
      thread_id: extra?.thread_id ?? "feishu:eng:cli",
      kind: extra?.kind ?? "im.message",
      is_bot: extra?.is_bot ?? false,
      text,
      has_subscriber: extra?.has_subscriber ?? false,
    },
    policy,
  );
}

describe(`default filter ${DEFAULT_FILTER_VERSION}`, () => {
  it("loads the versioned file as the executable policy", () => {
    expect(policy.version).toBe(DEFAULT_FILTER_VERSION);
    expect(policy.version).toBe("2026-11-18.1");
    expect(policy.defaultAction).toBe("candidate");
    expect(policy.rules.map((rule) => rule.name)).toEqual([
      "upstream-acp",
      "allowlist",
      "bot-chat",
      "ci-failure-subscribed",
      "ci-failure-open",
      "ci-other",
      "stop",
      "explicit-work",
      "chatter",
      "subscribed-clarification",
      "otherwise",
    ]);
  });

  it("ignores only whole-message chatter and makes zero Router calls", async () => {
    expect(judge("thanks").outcome).toBe("ignore");
    expect(judge("Thanks!").rule).toBe("chatter");
    expect(judge("lol").outcome).toBe("ignore");
    const harness = await startHarness();
    const before = await harness.engine.routerDecisionCount();
    const result = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "alice",
      text: "thanks",
      kind: "im.message",
      timestamp: 1,
    });
    await harness.engine.settle();
    expect(result.action).toBe("ignore");
    expect(result.rule).toBe("chatter");
    expect(await harness.engine.routerDecisionCount()).toBe(before);
    expect(await harness.engine.workers()).toHaveLength(0);
    const delivered = (await harness.engine.events()).filter((event) => event.type === "trigger.delivered");
    expect(delivered).toHaveLength(0);
    await harness.engine.close();
    await harness.store.close();
  });

  it("does not treat Morning all or coffee break as ignore", () => {
    for (const text of ["Morning all", "morning all", "coffee break", "Coffee break later"]) {
      const open = judge(text);
      expect(open.outcome, text).toBe("candidate");
      expect(open.rule, text).toBe("otherwise");
      const subscribed = judge(text, { has_subscriber: true });
      expect(subscribed.outcome, text).toBe("respond");
      expect(subscribed.rule, text).toBe("subscribed-clarification");
    }
  });

  it("keeps an ordinary clarification on a subscribed Thread", async () => {
    const text = "The typo is in the install section, not the title.";
    expect(judge(text, { has_subscriber: true })).toMatchObject({
      outcome: "respond",
      rule: "subscribed-clarification",
    });
    const longer = "lol thanks for the fix, but the empty list still prints null";
    expect(judge(longer, { has_subscriber: true }).outcome).toBe("respond");
    expect(judge(longer).outcome).toBe("candidate");

    const harness = await startHarness({ durationMs: 60 * 60_000 });
    await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please add a --json flag",
      kind: "im.message",
      timestamp: 1_000,
    });
    await harness.engine.settle();
    const decisions = await harness.engine.routerDecisionCount();
    const follow = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text,
      kind: "im.message",
      timestamp: 2_000,
    });
    await harness.engine.settle();
    expect(follow.action).toBe("respond");
    expect(follow.rule).toBe("subscribed-clarification");
    expect(follow.router).toBe(false);
    expect(follow.deliveredTo.length).toBe(1);
    expect(await harness.engine.routerDecisionCount()).toBe(decisions);
    await harness.engine.close();
    await harness.store.close();
  });
});
