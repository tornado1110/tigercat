const SECRET_KEY = /key|token|secret|password|credential/i;

export class SecretRegistry {
  private values: string[] = [];

  noteEnv(env: Record<string, string> | undefined): void {
    if (!env) return;
    for (const [key, value] of Object.entries(env)) {
      if (!SECRET_KEY.test(key)) continue;
      if (typeof value === "string" && value.length >= 4) this.values.push(value);
    }
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.values) {
      if (!value) continue;
      out = out.split(value).join("[REDACTED]");
    }
    return out;
  }

  redactValue(value: unknown): unknown {
    const encoded = this.redact(JSON.stringify(value));
    return JSON.parse(encoded) as unknown;
  }
}
