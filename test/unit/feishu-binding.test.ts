import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { BUILTIN_RUNTIMES, launchConfig } from "../../src/builtins.js";
import { loadOrRegisterFeishu } from "../../src/feishu-binding.js";
import { buildWorkerEnvironment } from "../../src/runtime.js";

it("resumes the approved profile and keeps registration secrets out of reports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tigercat-binding-"));
  const file = path.join(dir, "bindings.sqlite");
  const report = vi.fn();
  const register = vi.fn<Parameters<typeof loadOrRegisterFeishu>[2]>(async (options) => {
    expect(options.createOnly).toBe(true);
    expect(options.addons?.events?.items?.tenant).toContain("im.message.receive_v1");
    options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher", expireIn: 600 });
    await expect(loadOrRegisterFeishu(file, "project", register, report)).rejects.toMatchObject({ code: "feishu_busy" });
    return { client_id: "cli_example", client_secret: "test-secret", user_info: { open_id: "ou_creator" } };
  });
  try {
    await expect(loadOrRegisterFeishu(file, "project", async () => { throw { code: "expired_token", description: "test-secret" }; }, report)).rejects.toThrow("过期");
    const first = await loadOrRegisterFeishu(file, "project", register, report);
    expect(first.owner).toBe("ou_creator");
    expect(await loadOrRegisterFeishu(file, "project", register, report)).toEqual(first);
    expect(register).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain("test-secret");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("passes only the selected Codex provider's credential from the user configuration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tigercat-codex-provider-"));
  try {
    await writeFile(path.join(dir, "config.toml"), 'model_provider="gateway"\n[model_providers.gateway]\nenv_key="GATEWAY_AUTH_TOKEN"\n');
    const parent = { CODEX_HOME: dir, GATEWAY_AUTH_TOKEN: "provider", UNRELATED_TOKEN: "unrelated" };
    const runtime = launchConfig(BUILTIN_RUNTIMES.find((s) => s.name === "codex")!, parent);
    expect(runtime.providerCredentialEnv).toBe("GATEWAY_AUTH_TOKEN");
    const child = buildWorkerEnvironment({}, parent, "codex", runtime.providerCredentialEnv);
    expect(child.GATEWAY_AUTH_TOKEN).toBe("provider");
    expect(child.UNRELATED_TOKEN).toBeUndefined();
    expect(buildWorkerEnvironment({}, parent, "other").GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(runtime)).not.toContain('"provider"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
