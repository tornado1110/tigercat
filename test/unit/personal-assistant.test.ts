import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { PersonalAssistant } from "../../src/personal-assistant.js";
import { SqliteStore } from "../../src/store.js";
import type { LarkTransport } from "../../src/lark-transport.js";

class FixtureTransport implements LarkTransport {
  private fetches = 0;

  async status() { return { ok: true, status: "ready" as const, accountRef: "a", profileRef: "p", credentialRevision: "r" }; }
  async discover() { return { ok: true, value: {}, attempted: false, outcome: "success" as const }; }
  async execute() { return { ok: false, code: "invalid_request" as const, attempted: false }; }
  async write() { return this.execute(); }
  async api() { return this.execute(); }
  async read(args: readonly string[]) {
    if (args[0] === "drive") {
      return {
        ok: true,
        attempted: true,
        outcome: "success" as const,
        value: { data: { results: [{ entity_type: "WIKI", result_meta: {
          doc_types: "DOCX", token: "doc-1", url: "https://example.feishu.cn/wiki/doc-1",
          title_highlighted: "稿件一", owner_name: "作者甲", update_time: 1_700_000_000,
        } }] } },
      };
    }
    this.fetches += 1;
    return {
      ok: true,
      attempted: true,
      outcome: "success" as const,
      value: { data: { content: this.fetches === 1 ? "原始要求\n第一版" : "原始要求\n第二版" } },
    };
  }
}

describe("PersonalAssistant", () => {
  it("scans, confirms and reports a local document change", async () => {
    const store = SqliteStore.open(":memory:");
    const clock = new FakeClock(100);
    const assistant = new PersonalAssistant({ transport: new FixtureTransport(), store, clock });

    const scan = await assistant.scanCandidates();
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].id).toBe("docx:doc-1");

    const tracked = await assistant.confirm(["docx:doc-1"]);
    expect(tracked).toHaveLength(1);
    clock.advance(1000);
    const refreshed = await assistant.refresh();
    expect(refreshed.changes).toHaveLength(1);
    expect(refreshed.changes[0].summary).toContain("第二版");

    await assistant.close(["docx:doc-1"]);
    await expect(assistant.listTracked()).resolves.toHaveLength(0);
    await store.close();
  });
});
