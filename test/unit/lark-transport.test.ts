import { describe, expect, it } from "vitest";
import { LocalLarkCli, type LarkCliBinding, type LarkCliInvocation, type LarkCliRawResult } from "../../src/lark-cli.js";
import { LocalLarkTransport, MockLarkTransport } from "../../src/lark-transport.js";

function binding(): LarkCliBinding {
  return {
    accountRef: "app-transport-test",
    profileRef: "profile-transport-test",
    credentialHome: "/tmp/tigercat-lark-transport",
    credentialRevision: "revision-1",
  };
}

function ok(stdout: string): LarkCliRawResult {
  return { stdout, stderr: "", exitCode: 0, started: true };
}

describe("Lark transport capability", () => {
  it("maps structured GET and write API requests to fixed-profile argv", async () => {
    const calls: LarkCliInvocation[] = [];
    const transport = new LocalLarkTransport(new LocalLarkCli(binding(), {
      checkVersion: false,
      runner: async (invocation) => {
        calls.push(invocation);
        return ok(JSON.stringify({ ok: true, data: { id: "doc-1" } }));
      },
    }));
    await expect(transport.api({ method: "GET", path: "/open-apis/docs/v1/documents", params: { page_size: 10 } })).resolves.toMatchObject({ ok: true });
    await expect(transport.api({ method: "POST", path: "/open-apis/im/v1/messages", data: { content: "hello" } })).resolves.toMatchObject({ ok: true });
    expect(calls.map((call) => call.args)).toEqual([
      ["--profile", "profile-transport-test", "api", "GET", "/open-apis/docs/v1/documents", "--params", '{"page_size":10}', "--as", "user", "--json"],
      ["--profile", "profile-transport-test", "api", "POST", "/open-apis/im/v1/messages", "--data", '{"content":"hello"}', "--as", "user", "--json"],
    ]);
  });

  it("rejects shell-like paths and credential fields before invoking the CLI", async () => {
    let calls = 0;
    const transport = new LocalLarkTransport(new LocalLarkCli(binding(), {
      checkVersion: false,
      runner: async () => {
        calls += 1;
        return ok("{}");
      },
    }));
    await expect(transport.api({ method: "GET", path: "/open-apis/docs/v1/list?x=$(touch /tmp/nope)" })).resolves.toMatchObject({ ok: false, code: "invalid_request", attempted: false });
    await expect(transport.api({ method: "POST", path: "/open-apis/im/v1/messages", data: { access_token: "never-pass-a-token" } })).resolves.toMatchObject({ ok: false, code: "invalid_request", attempted: false });
    expect(calls).toBe(0);
  });

  it("provides deterministic discovery/read/write fixtures without starting lark-cli", async () => {
    const transport = new MockLarkTransport();
    await expect(transport.status()).resolves.toMatchObject({ ok: true, status: "ready", profileRef: "mock-profile" });
    await expect(transport.discover("lark-im")).resolves.toMatchObject({ ok: true, value: { name: "lark-im" }, attempted: false });
    await expect(transport.read(["docs", "list"])).resolves.toMatchObject({ ok: true, value: { mocked: true, effect: "read" }, attempted: false });
    await expect(transport.write(["im", "messages", "create"])).resolves.toMatchObject({ ok: true, value: { mocked: true, effect: "write" }, attempted: false });
    expect(transport.calls).toEqual([
      { operation: "read", args: ["docs", "list"] },
      { operation: "write", args: ["im", "messages", "create"] },
    ]);
  });

  it("keeps invalid mock API requests side-effect free", async () => {
    const transport = new MockLarkTransport();
    await expect(transport.api({ method: "DELETE", path: "/not-open-apis/resource" })).resolves.toMatchObject({ ok: false, code: "invalid_request", attempted: false });
    expect(transport.calls).toHaveLength(0);
  });

  it("applies the trusted revision check to mock calls too", async () => {
    const transport = new MockLarkTransport();
    await expect(transport.write(["im", "messages", "create"], "stale")).resolves.toMatchObject({ ok: false, code: "revision_mismatch", attempted: false });
    expect(transport.calls).toHaveLength(0);
  });

  it("keeps malformed mock calls side-effect free", async () => {
    const transport = new MockLarkTransport();
    await expect(transport.execute({ args: [], effect: "read" })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(transport.discover("-config")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(transport.calls).toHaveLength(0);
  });
});

