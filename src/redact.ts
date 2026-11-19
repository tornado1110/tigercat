const SECRET_KEY = /key|token|secret|password|credential/i;

/**
 * Values with these characters are not registered for exact replacement.
 * `redactValue` runs on a JSON string, and a raw quote or brace would
 * break that string.
 */
const UNSAFE_EXACT = /["\\{}]/;

const SECRET_VALUE = String.raw`(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s"'\\,{}]+)`;

const AUTH_HEADER = new RegExp(
  String.raw`\b(authorization\s*:\s*(?:bearer|basic|digest|token)\s+)${SECRET_VALUE}`,
  "gi",
);

const API_KEY_FIELD = new RegExp(
  String.raw`\b((?:x-api-key|api-key|api_key)\s*[:=]\s*)${SECRET_VALUE}`,
  "gi",
);

const ENV_ASSIGN = new RegExp(
  String.raw`\b([A-Za-z0-9_.-]*(?:key|token|secret|password|credential)[A-Za-z0-9_.-]*\s*=\s*)${SECRET_VALUE}`,
  "gi",
);

const JSON_SECRET_FIELD = new RegExp(
  String.raw`("(?:[^"\\]|\\.)*(?:key|token|secret|password|credential)(?:[^"\\]|\\.)*"\s*:\s*")((?:[^"\\]|\\.)*)(")`,
  "gi",
);

const PROVIDER_TOKEN = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g;

/**
 * Scrub credential-shaped text that was never registered with
 * {@link SecretRegistry}. Covers auth headers, `KEY=value` assignments
 * whose name looks secret, JSON fields with those names, and `sk-`
 * provider tokens. Ordinary words such as "token budget" are left alone.
 */
export function redactText(text: string): string {
  return text
    .replace(AUTH_HEADER, "$1[REDACTED]")
    .replace(API_KEY_FIELD, "$1[REDACTED]")
    .replace(ENV_ASSIGN, "$1[REDACTED]")
    .replace(JSON_SECRET_FIELD, "$1[REDACTED]$3")
    .replace(PROVIDER_TOKEN, "[REDACTED]");
}

export class SecretRegistry {
  private values: string[] = [];

  noteEnv(env: Record<string, string> | undefined): void {
    if (!env) return;
    for (const [key, value] of Object.entries(env)) {
      if (!SECRET_KEY.test(key)) continue;
      if (typeof value !== "string" || value.length < 4) continue;
      if (UNSAFE_EXACT.test(value)) continue;
      this.values.push(value);
    }
  }

  /**
   * Register secret-like variables from the parent environment.
   * Short values are skipped so a 4-character flag cannot blot out
   * unrelated event text.
   */
  noteProcessEnv(env: NodeJS.ProcessEnv | undefined): void {
    if (!env) return;
    const picked: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string" || value.length < 8) continue;
      picked[key] = value;
    }
    this.noteEnv(picked);
  }

  redact(text: string): string {
    let out = text;
    const values = [...this.values].sort((left, right) => right.length - left.length);
    for (const value of values) {
      if (!value) continue;
      out = out.split(value).join("[REDACTED]");
    }
    return redactText(out);
  }

  redactValue(value: unknown): unknown {
    const encoded = this.redact(JSON.stringify(value));
    return JSON.parse(encoded) as unknown;
  }
}
