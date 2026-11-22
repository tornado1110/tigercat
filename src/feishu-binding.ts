import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { registerApp } from "@larksuiteoapi/node-sdk";
import { TigerError } from "./errors.js";

export interface FeishuBinding {
  appId: string;
  appSecret: string;
  owner: string;
  brand: "feishu" | "lark";
}

export function bindingFile(): string {
  return path.join(homedir(), ".tigercat", "bindings", "feishu.sqlite");
}

export async function loadOrRegisterFeishu(file: string, profile: string, register: typeof registerApp, report: (message: string) => void): Promise<FeishuBinding> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await (await open(file, "a", 0o600)).close();
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS bots (profile TEXT PRIMARY KEY, appId TEXT NOT NULL, appSecret TEXT NOT NULL, owner TEXT NOT NULL, brand TEXT NOT NULL)");
    const read = () => db.prepare("SELECT appId, appSecret, owner, brand FROM bots WHERE profile = ?").get(profile) as unknown as FeishuBinding | undefined;
    const saved = read();
    if (saved) return saved;
    // A process exit releases the reservation, including while the user is scanning.
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) throw error;
      throw new TigerError("feishu_busy", "另一进程正在绑定飞书，请在已打开的授权页完成绑定。");
    }
    const existing = read();
    if (existing) return existing;
    let switched = false;
    const result = await register({
      source: "tigercat", createOnly: true,
      appPreset: { name: "TigerCat", desc: "通过飞书与本机项目的 TigerCat Worker 协作" },
      addons: {
        preset: false,
        scopes: { tenant: ["im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message.reactions:write_only"] },
        events: { items: { tenant: ["im.message.receive_v1"] } },
      },
      onQRCodeReady: ({ url, expireIn }) => report(`打开飞书官方页面，确认创建机器人（${Math.ceil(expireIn / 60)} 分钟内有效）\n${url}`),
      onStatusChange: ({ status }) => { if (status === "domain_switched") switched = true; },
    }).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      const message = code === "expired_token" ? "授权链接已过期" : code === "access_denied" ? "授权已取消" : "无法完成飞书设备授权";
      throw new TigerError("feishu_registration", `${message}，请重新运行 tigercat feishu connect。`);
    });
    if (!/^cli_[a-z0-9_]+$/i.test(result.client_id) || !result.client_secret) throw new TigerError("feishu_registration", "飞书未返回有效的应用凭据。");
    const binding: FeishuBinding = {
      appId: result.client_id, appSecret: result.client_secret, owner: result.user_info?.open_id ?? "",
      brand: switched || result.user_info?.tenant_brand === "lark" ? "lark" : "feishu",
    };
    db.prepare("INSERT INTO bots VALUES (?, ?, ?, ?, ?)").run(profile, binding.appId, binding.appSecret, binding.owner, binding.brand);
    db.exec("COMMIT");
    report("飞书已授权，机器人凭据已保存到本机。");
    return binding;
  } finally {
    db.close();
  }
}
