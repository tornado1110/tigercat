import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalLarkCli, type LarkCliBinding, type LarkCliInvocation, type LarkCliRawResult } from "../../src/lark-cli.js";

const temporary: string[] = [];

function binding(name: string, revision = "rev-1"): LarkCliBinding {
  return {
    accountRef: `app-${name}`,
    profileRef: `profile-${name}`,
    credentialHome: path.join(tmpdir(), `tigercat-lark-${name}`),
    credentialRevision: revision,
  };
}

function ok(stdout: string): LarkCliRawResult {
  return { stdout, stderr: "", exitCode: 0, started: true };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalLarkCli", () => {
  it("keeps profile and HOME isolated for concurrent calls", async () => {
    const seen: LarkCliInvocation[] = [];
    const runner = async (invocation: LarkCliInvocation): Promise<LarkCliRawResult> => {
      seen.push(invocation);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok(JSON.stringify({ identities: { user: { status: invocation.env.HOME?.includes("one") ? "ready" : "needs_refresh" } } }));
    };
    const one = new LocalLarkCli(binding("one"), { runner, checkVersion: false });
    const two = new LocalLarkCli(binding("two"), { runner, checkVersion: false });
    const [first, second] = await Promise.all([one.status(), two.status()]);
    expect(first.status).toBe("ready");
    expect(second.status).toBe("refreshable");
    expect(seen.map((call) => call.args.slice(0, 2))).toEqual([
      ["--profile", "profile-one"],
      ["--profile", "profile-two"],
    ]);
    expect(seen.map((call) => call.env.HOME)).toEqual([
      path.join(tmpdir(), "tigercat-lark-one"),
      path.join(tmpdir(), "tigercat-lark-two"),
    ]);
    expect(seen[0].env.XDG_CONFIG_HOME).toBe(path.join(tmpdir(), "tigercat-lark-one", ".config"));
  });

  it("normalizes needs_refresh to a refreshable user status", async () => {
    const cli = new LocalLarkCli(binding("refresh"), {
      checkVersion: false,
      runner: async () => ok(JSON.stringify({ identity: "bot", identities: { bot: { status: "ready" }, user: { status: "needs_refresh" } } })),
    });
    await expect(cli.status()).resolves.toMatchObject({ ok: true, status: "refreshable" });
  });

  it("does not confuse a missing profile binding with missing user authorization", async () => {
    const cli = new LocalLarkCli(binding("missing-profile"), {
      checkVersion: false,
      runner: async () => ({ ...ok(JSON.stringify({ ok: false, error: { type: "config", message: 'profile "other" not found' } })), exitCode: 3 }),
    });
    await expect(cli.status()).resolves.toMatchObject({ ok: false, status: "unavailable", code: "unavailable" });
  });

  it("rejects a stale trusted credential revision before spawning", async () => {
    let calls = 0;
    const cli = new LocalLarkCli(binding("revision", "new"), {
      checkVersion: false,
      runner: async () => {
        calls += 1;
        return ok("{}");
      },
    });
    await expect(cli.execute({ args: ["im", "messages", "list"], effect: "read", expectedRevision: "old" })).resolves.toMatchObject({
      ok: false,
      code: "revision_mismatch",
      attempted: false,
    });
    expect(calls).toBe(0);
  });

  it("keeps login, config and profile management outside the capability", async () => {
    const cli = new LocalLarkCli(binding("management"), { checkVersion: false, runner: async () => ok("{}") });
    for (const args of [["auth", "login"], ["config", "init"], ["profile", "use", "other"]]) {
      await expect(cli.execute({ args, effect: "write" })).resolves.toMatchObject({ ok: false, code: "invalid_request", attempted: false });
    }
  });

  it("rejects credential-like raw argv before a write confirmation can expose it", async () => {
    let calls = 0;
    const cli = new LocalLarkCli(binding("credential-args"), {
      checkVersion: false,
      runner: async () => {
        calls += 1;
        return ok("{}");
      },
    });
    await expect(cli.execute({ args: ["api", "POST", "/open-apis/example", "--data", '{"access_token":"secret"}'], effect: "write" })).resolves.toMatchObject({ ok: false, code: "invalid_request", attempted: false });
    expect(calls).toBe(0);
  });

  it("bounds raw argv before process launch", async () => {
    let calls = 0;
    const cli = new LocalLarkCli(binding("argv-bounds"), {
      checkVersion: false,
      runner: async () => {
        calls += 1;
        return ok("{}");
      },
    });
    await expect(cli.execute({ args: ["docs", "list", "x".repeat(65 * 1024)], effect: "read" })).resolves.toMatchObject({ ok: false, code: "invalid_request", attempted: false });
    expect(calls).toBe(0);
  });

  it("uses the same-minor compatibility strategy and caches the probe", async () => {
    const calls: LarkCliInvocation[] = [];
    const cli = new LocalLarkCli(binding("version"), {
      runner: async (invocation) => {
        calls.push(invocation);
        return ok(invocation.args.at(-1) === "--version" ? "lark-cli version 1.0.97\n" : "{\"ok\":true}");
      },
    });
    await expect(cli.probeVersion()).resolves.toMatchObject({ ok: true, version: "1.0.97" });
    await expect(cli.execute({ args: ["docs", "list"], effect: "read" })).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].args.slice(-1)).toEqual(["--version"]);
  });

  it("classifies explicit user scope, app scope and ACL errors", async () => {
    const response = (payload: unknown) => new LocalLarkCli(binding("errors"), { checkVersion: false, runner: async () => ({ ...ok(JSON.stringify(payload)), exitCode: 1 }) });
    await expect(response({ ok: false, error: { subtype: "missing_scope" } }).execute({ args: ["docs", "get"], effect: "read" })).resolves.toMatchObject({ code: "missing_user_scope" });
    await expect(response({ ok: false, error: { subtype: "app_scope_not_applied" } }).execute({ args: ["docs", "get"], effect: "read" })).resolves.toMatchObject({ code: "app_scope" });
    await expect(response({ ok: false, error: { subtype: "permission_not_granted" } }).execute({ args: ["docs", "get"], effect: "read" })).resolves.toMatchObject({ code: "acl" });
  });

  it("rejects a response naming a different app/profile", async () => {
    const cli = new LocalLarkCli(binding("bound"), {
      checkVersion: false,
      runner: async () => ok(JSON.stringify({ appId: "app-other", identities: { user: { status: "ready" } } })),
    });
    await expect(cli.status()).resolves.toMatchObject({ ok: false, status: "unavailable", code: "binding_mismatch" });
  });

  it("keeps the outer error envelope when CLI notices surround JSON", async () => {
    const cli = new LocalLarkCli(binding("notice"), {
      checkVersion: false,
      runner: async () => ({
        stdout: "notice before {\"ok\":false,\"error\":{\"subtype\":\"missing_scope\"}} notice after",
        stderr: "",
        exitCode: 1,
        started: true,
      }),
    });
    await expect(cli.execute({ args: ["docs", "get"], effect: "read" })).resolves.toMatchObject({ code: "missing_user_scope" });
  });

  it("returns outcome_unknown for a write timeout and never retries", async () => {
    let calls = 0;
    const cli = new LocalLarkCli(binding("timeout"), {
      checkVersion: false,
      runner: async () => {
        calls += 1;
        return { stdout: "", stderr: "", exitCode: null, started: true, timedOut: true };
      },
    });
    await expect(cli.execute({ args: ["im", "messages", "create"], effect: "write" })).resolves.toMatchObject({
      ok: false,
      code: "outcome_unknown",
      outcome: "outcome_unknown",
      attempted: true,
    });
    expect(calls).toBe(1);
  });

  it("reports a process that never started as unavailable instead of unknown", async () => {
    const cli = new LocalLarkCli(binding("spawn-error"), {
      checkVersion: false,
      runner: async () => ({ stdout: "", stderr: "", exitCode: null, error: "ENOENT" }),
    });
    await expect(cli.execute({ args: ["docs", "list"], effect: "write" })).resolves.toMatchObject({ ok: false, code: "unavailable", attempted: false });
  });

  it("uses argv without a shell and confines a local stub to the binding HOME", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tigercat-lark-stub-"));
    temporary.push(root);
    const stub = path.join(root, "stub.mjs");
    await writeFile(stub, [
      "const fs = await import('node:fs');",
      "const out = { args: process.argv.slice(2), home: process.env.HOME };",
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n"));
    await chmod(stub, 0o755);
    const cli = new LocalLarkCli({ ...binding("stub"), credentialHome: path.join(root, "credential-home") }, {
      binary: process.execPath,
      prefixArgs: [stub],
      checkVersion: false,
    });
    const result = await cli.execute({ args: ["docs", "list"], effect: "read" });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ args: ["--profile", "profile-stub", "docs", "list", "--as", "user", "--json"] });
    expect((result.value as { home: string }).home).toBe(path.join(root, "credential-home"));
  });
});

