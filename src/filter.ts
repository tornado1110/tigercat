import { TigerError } from "./errors.js";
import type { FilterAction } from "./types.js";

/**
 * Generic ordered rule engine. The first matching rule wins.
 * Match fields: source, thread_id prefix, kind, is_bot, text regex,
 * and whether the Thread already has a subscribed Worker.
 * A `not` block matches when its inner predicate does not.
 * `interrupt` is a side effect of a match (cancel the Worker turn);
 * it does not change the outcome.
 */
export interface RuleMatch {
  source?: string | string[];
  thread_id_prefix?: string | string[];
  kind?: string | string[];
  is_bot?: boolean;
  /**
   * Regular expression tested against the trigger text.
   * Trigger text is NFKC-normalized. Pattern literals are NFKC-folded too,
   * and any ASCII regex syntax produced by that fold is escaped, so fullwidth
   * punctuation stays a literal. A backslash before a non-ASCII code point is
   * the same kind of literal (`\＊` matches `*`). A `]` right after `[` or
   * `[^` ends the class. A single code point inside a character class must
   * not fold to more than one code point; that is a config error naming the
   * rule. A folded code point above U+FFFF is `\u{...}` when the rule asks
   * for `u`, otherwise a surrogate pair of `\uXXXX` escapes. A quantifier
   * stays attached to the last folded character (`ﬁ+` is `fi+`). Matching is
   * always case-insensitive (`i` is set even without `(?i)`). Accents are
   * not stripped. `(?u)` enables Unicode properties such as `\p{L}`; the
   * engine does not add `u` on its own.
   */
  text?: string;
  has_subscriber?: boolean;
  not?: RuleMatch;
}

export interface FilterRule {
  name?: string;
  match?: RuleMatch;
  outcome: FilterAction;
  interrupt?: boolean;
}

export interface FilterConfig {
  /** Stable id of this rule set. QA calibrates fixtures against this, not the other way around. */
  version: string;
  defaultAction: FilterAction;
  rules: FilterRule[];
}

export interface RuleInput {
  source: string;
  thread_id: string;
  kind: string;
  is_bot: boolean;
  text: string;
  has_subscriber: boolean;
}

export interface Admission {
  outcome: FilterAction;
  interrupt: boolean;
  rule: string | null;
}

export function admit(input: RuleInput, config: FilterConfig): Admission {
  for (let index = 0; index < config.rules.length; index += 1) {
    const rule = config.rules[index];
    const label = ruleLabel(rule, index);
    if (!matches(rule.match, input, label)) continue;
    return {
      outcome: rule.outcome,
      interrupt: rule.interrupt === true && input.has_subscriber,
      rule: rule.name ?? `rule-${index + 1}`,
    };
  }
  return { outcome: config.defaultAction, interrupt: false, rule: null };
}

/** Compile every text pattern. Throws a config error for an illegal compatibility fold. */
export function compileFilterRules(rules: FilterRule[]): void {
  rules.forEach((rule, index) => compileMatch(rule.match, ruleLabel(rule, index)));
}

export function matches(match: RuleMatch | undefined, input: RuleInput, label = "rule"): boolean {
  if (!match) return true;
  if (match.not && matches(match.not, input, label)) return false;
  if (match.source !== undefined && !oneOf(match.source, input.source)) return false;
  if (match.thread_id_prefix !== undefined && !hasPrefix(match.thread_id_prefix, input.thread_id)) return false;
  if (match.kind !== undefined && !oneOf(match.kind, input.kind)) return false;
  if (match.is_bot !== undefined && match.is_bot !== input.is_bot) return false;
  if (match.has_subscriber !== undefined && match.has_subscriber !== input.has_subscriber) return false;
  if (match.text !== undefined && !testRegex(match.text, input.text, label)) return false;
  return true;
}

function ruleLabel(rule: FilterRule, index: number): string {
  return rule.name ? `"${rule.name}"` : String(index + 1);
}

function compileMatch(match: RuleMatch | undefined, label: string): void {
  if (!match) return;
  if (match.text !== undefined) compileRulePattern(match.text, label);
  if (match.not) compileMatch(match.not, label);
}

function compileRulePattern(pattern: string, label: string): void {
  const { flags, body } = splitFlags(pattern);
  const normalized = normalizePattern(body, flags.includes("u"), label);
  try {
    new RegExp(normalized, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TigerError("invalid_config", `rule ${label}: invalid regular expression (${message})`);
  }
}

function oneOf(expected: string | string[], actual: string): boolean {
  const list = Array.isArray(expected) ? expected : [expected];
  return list.includes(actual);
}

function hasPrefix(prefixes: string | string[], value: string): boolean {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  return list.some((prefix) => value.startsWith(prefix));
}

/**
 * NFKC only. Compatibility forms fold (fullwidth letters, ligatures) and a
 * decomposed accent composes (`e` + U+0301 → `é`). Case is left to the `i`
 * flag. Accents are not stripped, so `sí` and `si` stay distinct.
 */
function normalizeMatchText(value: string): string {
  return value.normalize("NFKC");
}

/** ASCII characters that are regex syntax and therefore split literal runs. */
const REGEX_SYNTAX = new Set("^$.*+?()[]{}|/\\-");

/**
 * NFKC each literal run. Escape sequences stay verbatim. A non-ASCII source
 * character that folds into ASCII regex syntax is emitted as a `\uXXXX`
 * literal, so fullwidth punctuation never becomes an operator. A code point
 * inside a character class that folds to more than one code point is a
 * config error.
 */
function normalizePattern(body: string, unicode: boolean, label: string): string {
  const chars = [...body];
  let out = "";
  let run = "";
  let inClass = false;
  let classAtStart = false;
  const flush = () => {
    if (!run) return;
    out += foldLiteralRun(run, inClass, unicode, label);
    run = "";
  };
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (ch === "\\") {
      const next = chars[i + 1];
      const nextCode = next === undefined ? 0 : (next.codePointAt(0) ?? 0);
      if (next !== undefined && nextCode > 127) {
        run += next;
        i += 1;
        if (inClass) classAtStart = false;
        continue;
      }
      flush();
      const escape = readEscape(chars, i);
      out += escape.text;
      i = escape.next - 1;
      if (inClass) classAtStart = false;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 128 && REGEX_SYNTAX.has(ch)) {
      flush();
      out += ch;
      if (!inClass && ch === "[") {
        inClass = true;
        classAtStart = true;
      } else if (inClass && ch === "^" && classAtStart) {
        // Negation. A following ] closes an empty negated class, as in JS.
      } else if (inClass && ch === "]") {
        inClass = false;
        classAtStart = false;
      } else if (inClass) {
        classAtStart = false;
      }
      continue;
    }
    run += ch;
    if (inClass) classAtStart = false;
  }
  flush();
  return out;
}

function foldLiteralRun(run: string, inClass: boolean, unicode: boolean, label: string): string {
  if (inClass) {
    for (const cp of run) {
      if ([...cp.normalize("NFKC")].length > 1) {
        throw new TigerError(
          "invalid_config",
          `rule ${label}: multi-character compatibility forms are not supported inside character classes`,
        );
      }
    }
  }
  const folded = run.normalize("NFKC");
  if (folded === run) return run;
  let out = "";
  for (const cp of folded) {
    const code = cp.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      out += unicode ? `\\u{${code.toString(16).toUpperCase()}}` : surrogateEscapes(code);
    } else if (code < 128 && REGEX_SYNTAX.has(cp)) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else {
      out += cp;
    }
  }
  return out;
}

function surrogateEscapes(code: number): string {
  const value = code - 0x10000;
  const hi = 0xd800 + (value >> 10);
  const lo = 0xdc00 + (value & 0x3ff);
  return `\\u${toHex4(hi)}\\u${toHex4(lo)}`;
}

function toHex4(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, "0");
}

function readEscape(chars: string[], start: number): { text: string; next: number } {
  const next = chars[start + 1];
  if (next === undefined) return { text: "\\", next: start + 1 };
  if ((next === "u" || next === "x" || next === "p" || next === "P") && chars[start + 2] === "{") {
    const end = chars.indexOf("}", start + 2);
    if (end !== -1) return { text: chars.slice(start, end + 1).join(""), next: end + 1 };
  }
  if (next === "u" && isHex(chars, start + 2, 4)) {
    return { text: chars.slice(start, start + 6).join(""), next: start + 6 };
  }
  if (next === "x" && isHex(chars, start + 2, 2)) {
    return { text: chars.slice(start, start + 4).join(""), next: start + 4 };
  }
  if (next === "c" && chars[start + 2] !== undefined) {
    return { text: chars.slice(start, start + 3).join(""), next: start + 3 };
  }
  return { text: chars.slice(start, start + 2).join(""), next: start + 2 };
}

function isHex(chars: string[], start: number, length: number): boolean {
  for (let i = 0; i < length; i += 1) {
    const ch = chars[start + i];
    if (ch === undefined || !/^[0-9a-fA-F]$/.test(ch)) return false;
  }
  return true;
}

function splitFlags(pattern: string): { flags: string; body: string } {
  let flags = "";
  let body = pattern;
  const inline = /^\(\?([a-z]+)\)/.exec(pattern);
  if (inline) {
    flags = inline[1];
    body = pattern.slice(inline[0].length);
  }
  if (!flags.includes("i")) flags += "i";
  return { flags, body };
}

function testRegex(pattern: string, text: string, label: string): boolean {
  const { flags, body } = splitFlags(pattern);
  const normalized = normalizePattern(body, flags.includes("u"), label);
  return new RegExp(normalized, flags).test(normalizeMatchText(text));
}
