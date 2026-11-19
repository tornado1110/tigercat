import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER_VERSION, defaultConfig, loadConfig } from "../../src/config.js";
import { TigerError } from "../../src/errors.js";
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
    expect(policy.version).toBe("2026-11-19.1");
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

function judgeRule(text: string, pattern: string) {
  return admit(
    {
      source: "feishu",
      thread_id: "feishu:eng:cli",
      kind: "im.message",
      is_bot: false,
      text,
      has_subscriber: false,
    },
    {
      version: "test",
      defaultAction: "candidate",
      rules: [{ name: "chatter", outcome: "ignore", match: { text: pattern } }],
    },
  );
}

describe("ja/ko/es default stop words", () => {
  it("matches listed Spanish accent variants and not unlisted ones", () => {
    for (const text of ["gracias", "vale", "de acuerdo", "sí", "si", "adiós", "¡gracias!"]) {
      expect(judge(text), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
    // i + U+0301 composes to the listed sí. The accent is kept, not stripped.
    expect(judge("si\u0301")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(judge("adios")).toMatchObject({ outcome: "candidate", rule: "otherwise" });
    expect(judge("valé")).toMatchObject({ outcome: "candidate", rule: "otherwise" });
  });

  it("does not drop a Japanese stop word inside a task request", () => {
    for (const text of ["ありがとう", "了解", "お疲れ様", "ありがとう。"]) {
      expect(judge(text), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
    const task = "ログインできない障害を調査して直してください。ありがとう";
    expect(task.includes("ありがとう")).toBe(true);
    expect(judge(task)).toMatchObject({ outcome: "candidate", rule: "otherwise" });
  });

  it("does not match a Latin stop word embedded in a longer word", () => {
    expect(judge("vale")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(judge("gracias")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    for (const text of ["valencia", "milgracias", "okok"]) {
      expect(judge(text), text).toMatchObject({ outcome: "candidate", rule: "otherwise" });
    }
    const chatter = policy.rules.find((rule) => rule.name === "chatter");
    expect(chatter?.match?.text?.startsWith("(?iu)")).toBe(true);
    expect(chatter?.match?.text).toContain("(?<![\\p{L}\\p{N}])");
    expect(chatter?.match?.text).toContain("(?![\\p{L}\\p{N}])");
    expect(chatter?.match?.text?.includes("\\b")).toBe(false);
  });

  it("ignores Korean acknowledgements and keeps a task that contains one", () => {
    for (const text of ["감사합니다", "고마워요", "알겠습니다"]) {
      expect(judge(text), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
    const task = "알겠습니다. 하지만 빌드 오류는 아직 고쳐 주세요";
    expect(judge(task)).toMatchObject({ outcome: "candidate", rule: "otherwise" });
  });

  it("matches fullwidth and halfwidth ok after NFKC", () => {
    for (const text of ["ok", "ｏｋ", "ＯＫ"]) {
      expect(judge(text), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
    // The rule list is folded too: a fullwidth pattern matches halfwidth input.
    const rule = "(?u)^(?<![\\p{L}\\p{N}])ＯＫ(?![\\p{L}\\p{N}])$";
    expect(judgeRule("ok", rule)).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(judgeRule("ｏｋ", rule)).toMatchObject({ outcome: "ignore", rule: "chatter" });
  });

  it("matches precomposed é and decomposed e + combining acute after NFKC", () => {
    const precomposed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(precomposed.normalize("NFC").codePointAt(3)).toBe(0x00e9);
    expect(decomposed.codePointAt(4)).toBe(0x0301);
    expect(precomposed.normalize("NFKC")).toBe(decomposed.normalize("NFKC"));
    const precomposedRule = "(?u)^(?<![\\p{L}\\p{N}])caf\u00e9(?![\\p{L}\\p{N}])$";
    const decomposedRule = "(?u)^(?<![\\p{L}\\p{N}])cafe\u0301(?![\\p{L}\\p{N}])$";
    const bare = "(?u)^(?<![\\p{L}\\p{N}])cafe(?![\\p{L}\\p{N}])$";
    for (const pattern of [precomposedRule, decomposedRule]) {
      expect(judgeRule(precomposed, pattern).outcome).toBe("ignore");
      expect(judgeRule(decomposed, pattern).outcome).toBe("ignore");
      expect(judgeRule("CAF\u00c9", pattern).outcome).toBe("ignore");
      expect(judgeRule("cafe", pattern).outcome).toBe("candidate");
    }
    expect(judgeRule(precomposed, bare).outcome).toBe("candidate");
    expect(judgeRule(decomposed, bare).outcome).toBe("candidate");
  });

  it("matches GRACIAS and Gracias", () => {
    for (const text of ["gracias", "Gracias", "GRACIAS"]) {
      expect(judge(text), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
    // The engine sets `i` even when the rule omits `(?i)`.
    const rule = "(?u)^(?<![\\p{L}\\p{N}])GRACIAS(?![\\p{L}\\p{N}])$";
    for (const text of ["gracias", "Gracias", "GRACIAS"]) {
      expect(judgeRule(text, rule), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
  });

  it("keeps uppercase escapes and classes working under case-insensitive NFKC matching", () => {
    expect(judgeRule("12345", "\\D+").outcome).toBe("candidate");
    expect(judgeRule("abc", "\\D+").outcome).toBe("ignore");
    expect(judgeRule("A", "(?u)\\p{Lu}").outcome).toBe("ignore");
    expect(judgeRule("É", "\\u00C9").outcome).toBe("ignore");
    expect(judgeRule("é", "\\u00C9").outcome).toBe("ignore");
    expect(judgeRule("É", "(?u)\\u{C9}").outcome).toBe("ignore");
    expect(judgeRule("é", "(?u)\\u{C9}").outcome).toBe("ignore");
    expect(judgeRule("a", "\\x41").outcome).toBe("ignore");
    expect(judgeRule("A", "\\x41").outcome).toBe("ignore");
    expect(judgeRule("hello", "[A-Z]+").outcome).toBe("ignore");
    // Text NFKC turns an ellipsis into dots, so the punctuation class does not contain U+2026.
    expect(judge("ok…").outcome).toBe("ignore");
  });

  it("keeps fullwidth punctuation as literals instead of regex syntax", async () => {
    expect(judgeRule("［重要］发布", "［重要］")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(judgeRule("[重要]", "［重要］")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(judgeRule("需要修复登录 bug", "［重要］")).toMatchObject({ outcome: "candidate", rule: null });
    expect(judgeRule("公告|周报", "^公告｜周报$")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(judgeRule("公告", "^公告｜周报$")).toMatchObject({ outcome: "candidate", rule: null });
    expect(() => judgeRule("*", "＊")).not.toThrow();
    expect(judgeRule("*", "＊")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    expect(() => judgeRule("(", "（")).not.toThrow();
    expect(judgeRule("(", "（")).toMatchObject({ outcome: "ignore", rule: "chatter" });

    const harness = await startHarness();
    harness.engine.config.filter = {
      version: "test",
      defaultAction: "candidate",
      rules: [
        { name: "boxed", outcome: "ignore", match: { text: "［重要］" } },
        { name: "star", outcome: "ignore", match: { text: "＊" } },
        { name: "paren", outcome: "ignore", match: { text: "（" } },
      ],
    };
    await expect(
      harness.engine.ingest({
        source: "feishu",
        thread: "feishu:eng:cli",
        author: "alice",
        text: "需要修复登录 bug",
        kind: "im.message",
        timestamp: 1,
      }),
    ).resolves.toMatchObject({ action: "candidate" });
    await expect(
      harness.engine.ingest({
        source: "feishu",
        thread: "feishu:eng:cli",
        author: "alice",
        text: "＊",
        kind: "im.message",
        timestamp: 2,
      }),
    ).resolves.toMatchObject({ action: "ignore" });
    await harness.engine.close();
    await harness.store.close();
  });

  it("preserves non-digit, non-space, and non-word escapes", () => {
    expect(judgeRule("x", "\\S+").outcome).toBe("ignore");
    expect(judgeRule("   ", "\\S+").outcome).toBe("candidate");
    expect(judgeRule("!!", "\\W+").outcome).toBe("ignore");
    expect(judgeRule("ab", "\\W+").outcome).toBe("candidate");
    expect(judgeRule("ab", "a\\Bb").outcome).toBe("ignore");
    expect(judgeRule("a b", "a\\Bb").outcome).toBe("candidate");
  });

  it("folds a ligature outside a class and rejects one inside", () => {
    expect(judgeRule("fix", "ﬁx")).toMatchObject({ outcome: "ignore", rule: "chatter" });
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-class-"));
    const file = path.join(dir, "config.toml");
    writeFileSync(
      file,
      [
        "[[filter.rules]]",
        'name = "ligature"',
        'outcome = "ignore"',
        "",
        "[filter.rules.match]",
        'text = "[ﬁ]"',
        "",
      ].join("\n"),
    );
    try {
      expect(() => loadConfig(file)).toThrow(TigerError);
      expect(() => loadConfig(file)).toThrow(/ligature/);
      expect(() => loadConfig(file)).toThrow(/multi-character compatibility forms are not supported inside character classes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("composes a literal combining mark with its ASCII base", () => {
    const pattern = "si\u0301";
    expect(judgeRule("sí", pattern).outcome).toBe("ignore");
    expect(judgeRule("si\u0301", pattern).outcome).toBe("ignore");
  });

  it("folds a supplementary mathematical letter without throwing", () => {
    const pattern = "\u{1D400}";
    expect(pattern.codePointAt(0)).toBe(0x1d400);
    for (const text of ["A", "a"]) {
      expect(judgeRule(text, pattern), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule(text, `(?u)${pattern}`), text).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
  });

  it("treats a backslash before a non-ASCII character as a literal", () => {
    for (const prefix of ["", "(?u)"]) {
      expect(judgeRule("*", `${prefix}\\＊`), prefix).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule("＊", `${prefix}\\＊`), prefix).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule("(", `${prefix}\\（`), prefix).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule("（", `${prefix}\\（`), prefix).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule("公告|周报", `${prefix}^公告\\｜周报$`), prefix).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule("公告", `${prefix}^公告\\｜周报$`), prefix).toMatchObject({ outcome: "candidate", rule: null });
    }
  });

  it("does not treat ] after [ as still inside the class", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-empty-class-"));
    const file = path.join(dir, "config.toml");
    writeFileSync(
      file,
      [
        "[[filter.rules]]",
        'name = "empty"',
        'outcome = "ignore"',
        "",
        "[filter.rules.match]",
        'text = "[]ﬁ]"',
        "",
      ].join("\n"),
    );
    try {
      expect(() => loadConfig(file)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds a compatibility ideograph above the BMP with and without u", () => {
    const pattern = "\uFA6C";
    const folded = "\u{242EE}";
    expect(pattern.normalize("NFKC")).toBe(folded);
    for (const text of [pattern, folded]) {
      expect(judgeRule(text, pattern), `plain ${text}`).toMatchObject({ outcome: "ignore", rule: "chatter" });
      expect(judgeRule(text, `(?u)${pattern}`), `u ${text}`).toMatchObject({ outcome: "ignore", rule: "chatter" });
    }
  });
});
