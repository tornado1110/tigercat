import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { PersonalResourceTracker, type ResourceCandidate, type ResourceSource } from "../../src/personal-resources.js";
import { SqliteStore } from "../../src/store.js";

class FixtureSource implements ResourceSource {
  private fetches = 0;

  async search() {
    return { candidates: [{ id: "documents:docx:doc-1", source: "documents", kind: "DOCX", title: "resource one", url: "https://example.test/resource/1", locator: { token: "doc-1" }, metadata: {} }], errors: [] };
  }

  async read(_resource: ResourceCandidate) {
    this.fetches += 1;
    return this.fetches === 1 ? "baseline\nversion one" : "baseline\nversion two";
  }
}

describe("PersonalResourceTracker", () => {
  it("scans, confirms and reports a local document change", async () => {
    const store = SqliteStore.open(":memory:");
    const clock = new FakeClock(100);
    const assistant = new PersonalResourceTracker({ source: new FixtureSource(), store, clock });

    const scan = await assistant.scan({ source: "documents" });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].id).toBe("documents:docx:doc-1");

    const tracked = await assistant.confirm(["documents:docx:doc-1"]);
    expect(tracked).toHaveLength(1);
    clock.advance(1000);
    const refreshed = await assistant.refresh();
    expect(refreshed.changes).toHaveLength(1);
    expect(refreshed.changes[0].summary).toContain("version two");

    await assistant.close(["documents:docx:doc-1"]);
    await expect(assistant.list()).resolves.toHaveLength(0);
    await store.close();
  });
});
