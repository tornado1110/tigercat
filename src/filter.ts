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
  /** Regular expression tested against the trigger text. A leading `(?i)` is honored. */
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
    if (!matches(rule.match, input)) continue;
    return {
      outcome: rule.outcome,
      interrupt: rule.interrupt === true && input.has_subscriber,
      rule: rule.name ?? `rule-${index + 1}`,
    };
  }
  return { outcome: config.defaultAction, interrupt: false, rule: null };
}

export function matches(match: RuleMatch | undefined, input: RuleInput): boolean {
  if (!match) return true;
  if (match.not && matches(match.not, input)) return false;
  if (match.source !== undefined && !oneOf(match.source, input.source)) return false;
  if (match.thread_id_prefix !== undefined && !hasPrefix(match.thread_id_prefix, input.thread_id)) return false;
  if (match.kind !== undefined && !oneOf(match.kind, input.kind)) return false;
  if (match.is_bot !== undefined && match.is_bot !== input.is_bot) return false;
  if (match.has_subscriber !== undefined && match.has_subscriber !== input.has_subscriber) return false;
  if (match.text !== undefined && !testRegex(match.text, input.text)) return false;
  return true;
}

function oneOf(expected: string | string[], actual: string): boolean {
  const list = Array.isArray(expected) ? expected : [expected];
  return list.includes(actual);
}

function hasPrefix(prefixes: string | string[], value: string): boolean {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  return list.some((prefix) => value.startsWith(prefix));
}

function testRegex(pattern: string, text: string): boolean {
  let flags = "";
  let body = pattern;
  const inline = /^\(\?([a-z]+)\)/.exec(pattern);
  if (inline) {
    flags = inline[1];
    body = pattern.slice(inline[0].length);
  }
  return new RegExp(body, flags).test(text);
}
