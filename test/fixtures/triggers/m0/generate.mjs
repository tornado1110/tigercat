#!/usr/bin/env node
/**
 * Deterministic Trigger stream generator for TigerCat replay tests.
 *
 * Usage:
 *   node generate.mjs --seed 1 --count 300 --work 20 > stream.jsonl
 *
 * Stdout is JSONL only. A composition summary is written to stderr.
 * No dependencies; plain Node. Seeded with mulberry32.
 *
 * Labels follow examples/rules.default.toml version 2026-11-19.1.
 * This generator does not invent a wider ignore list. A spawn subscribes
 * only its home thread, which is what the scripted Router brain does.
 * Schema notes: ../README.md
 */
"use strict";

const USAGE = `Usage: node generate.mjs --seed 1 --count 300 --work 20 > stream.jsonl

Generate a deterministic JSONL Trigger stream for TigerCat replay tests.

Flags:
  --seed  <int>   PRNG seed (default: 1)
  --count <int>   total triggers (default: 300)
  --work  <int>   explicit work requests that spawn a Worker (default: 20)
  --help          print this message

Counts are exact. Composition (when there is room):
  stops      = min(work, max(1, round(work * 0.25)))  (0 if work is 0)
  followUps  = min(remaining, work * 2)
  ciNoise    = min(remaining, round(count * 0.12))
  chatter    = the rest

\`expect\` labels are the versioned default rules (2026-11-19.1).
Each spawn subscribes only its home thread.
`;

const START_TS = Date.parse("2026-03-02T01:00:00.000Z");
const AUTHORS = ["keith", "alice", "bob", "chen", "priya"];
const BOT_IM = "tigercat-bot";
const BOT_GH = "github-actions[bot]";

const WORK_TEXTS = [
  "Please add a --json flag to `tigercat list` and document it in the README.",
  "Please implement session resume on `tigercat acp` after a daemon restart.",
  "Please add a `tigercat runtime test` command that runs the downstream contract checks.",
  "Please investigate why `session/cancel` leaves a stale worktree behind.",
  "Please write a SECURITY.md section that credentials must not enter the model context.",
  "Please document the stall timeout default (10 minutes) in the CLI help.",
  "Please refactor the event log to use node:sqlite with a monotonic seq per worker.",
  "Please fix the typo in the README install section.",
  "Please add tests for the two-level trigger filter, one file per rule.",
  "Please implement worker.stalled after the configured idle timeout.",
  "Please change `tigercat wait` so it is a convenience tool, not the main result path.",
  "Please add RuntimeFactory injection so tests can swap in stub agents.",
  "Please set acp-tck to a pinned version in CI and run the MANDATORY tier on ubuntu, macos, and windows.",
  "Please implement spawn so it returns started immediately and does not block.",
  "Please add a Clock interface so stall tests do not sleep in real time.",
  "Please write a hook that records worker.turn_end summaries with a size cap.",
  "Please replace the in-memory event log with an append-only sqlite log.",
  "Please add `--approve auto|ask|deny` with default ask, and never auto-allow by accident.",
  "Please create a worktree per Worker and detect overlapping edits.",
  "Please implement session/load recovery, and mark the session interrupted if load fails.",
  "Please document how Triggers, Threads, and Workers relate in the architecture doc.",
  "Please add idempotent interrupt and kill tool handlers with typed errors.",
  "Please implement batching of Triggers that arrive while the Router is mid-turn.",
  "Please add a `tigercat runtime test` fixture for the no-session-load stub.",
];

const FOLLOWUP_TEXTS = [
  "Also handle the empty-list case: print `[]` and exit 0.",
  "Put the tests next to the command, not in a new package.",
  "Please also document the default next to the flag in the README.",
  "Please write a regression test for seq gaps after a crash.",
  "The typo is in the install section, not the title.",
  "Put the tests in test/filter/, one file per rule.",
  "Please keep the public CLI names stable.",
  "Please use node:sqlite, not a third-party binding.",
  "Do not touch the Docker image in this change.",
  "Please make the error message name the unknown worker id.",
  "Also cover Windows path separators in the worktree test.",
  "Please cap the coordinator payload at 8 KiB and include a readable reference.",
];

const STOP_TEXTS = [
  "please stop this task",
  "cancel this worker",
  "interrupt this, I will finish it myself",
  "stop, do not continue",
];

// Social-noise pool. Filter outcome is decided by POLICY_VERSION, not by
// membership in this list. "Morning all" and "coffee break" are not ignore.
const CHATTER_TEXTS = [
  "morning",
  "Morning all",
  "ok",
  "OK thanks",
  "thanks",
  "thank you",
  "+1",
  "lol",
  "haha",
  "Have a good evening.",
  "anyone around for lunch?",
  "I am in, 12:30 works.",
  "nice",
  "sg",
  "got it",
  "sounds good",
  "brb",
  "see you tomorrow",
  "coffee break",
];

// Copied from examples/rules.default.toml version 2026-11-19.1.
// A leading (?i) / (?iu) is a flag, matching src/filter.ts. `i` is always set.
// `u` is added only when the pattern asks for it. Do not widen these.
// normalizeMatchText / normalizePattern stay in lockstep with src/filter.ts.
const POLICY_VERSION = "2026-11-19.1";
const CHATTER_PATTERN =
  "(?iu)^[¡¿]*(?:(?<![\\p{L}\\p{N}])(?:morning|good morning|good night|hello|hi|hey|thanks|thank you|thx|ty|ok|okay|\\+1|lol|lgtm|nice|cool|haha|wow|lunch|brb|gtg|muchas gracias|de acuerdo|gracias|vale|sí|si|adiós)(?![\\p{L}\\p{N}])|ありがとうございます|ありがとう|お疲れ様です|お疲れさまです|お疲れ様|お疲れさま|おつかれさまです|おつかれさま|おつかれ|了解です|了解|감사합니다|고마워요|알겠습니다)[.!\\s。、]*$|^(?:👍|🎉|👋|😂|🙏|✅|❤️)+$";
const STOP_PATTERN =
  "(?i)please stop this task|cancel this worker|interrupt this, I will finish it myself|stop, do not continue|stop, do .+ instead";
const EXPLICIT_PATTERN =
  "(?i)@tigercat|\\bplease\\s+(add|fix|implement|refactor|write|change|update|remove|delete|investigate|document|run|create|replace|move|rename|set|keep)\\b|^(?:please\\s+)?(add|fix|implement|refactor|write|change|update|remove|delete|investigate|document|run|create|replace|move|rename|set|keep)\\b";
const CI_FAIL_PATTERN = "(?i)fail|failed|failure";

function normalizeMatchText(value) {
  return value.normalize("NFKC");
}

// ASCII regex syntax. These split literal runs. Keep in lockstep with src/filter.ts.
const REGEX_SYNTAX = new Set("^$.*+?()[]{}|/\\-");

function normalizePattern(body, unicode, label) {
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

function foldLiteralRun(run, inClass, unicode, label) {
  if (inClass) {
    for (const cp of run) {
      if ([...cp.normalize("NFKC")].length > 1) {
        throw new Error(
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

function surrogateEscapes(code) {
  const value = code - 0x10000;
  const hi = 0xd800 + (value >> 10);
  const lo = 0xdc00 + (value & 0x3ff);
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  return `\\u${hex(hi)}\\u${hex(lo)}`;
}

function readEscape(chars, start) {
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

function isHex(chars, start, length) {
  for (let i = 0; i < length; i += 1) {
    const ch = chars[start + i];
    if (ch === undefined || !/^[0-9a-fA-F]$/.test(ch)) return false;
  }
  return true;
}

function testPolicyRegex(pattern, text) {
  let flags = "";
  let body = pattern;
  const inline = /^\(\?([a-z]+)\)/.exec(pattern);
  if (inline) {
    flags = inline[1];
    body = pattern.slice(inline[0].length);
  }
  if (!flags.includes("i")) flags += "i";
  body = normalizePattern(body, flags.includes("u"), "pattern");
  return new RegExp(body, flags).test(normalizeMatchText(text));
}

function parseArgs(argv) {
  const out = { seed: 1, count: 300, work: 20, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    const eq = a.match(/^--(seed|count|work)=(.*)$/);
    if (eq) {
      out[eq[1]] = eq[2];
      continue;
    }
    if (a === "--seed" || a === "--count" || a === "--work") {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      out[a.slice(2)] = argv[++i];
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  for (const name of ["seed", "count", "work"]) {
    if (!/^-?\d+$/.test(String(out[name]))) throw new Error(`${name} must be an integer`);
    out[name] = Number(out[name]);
    if (out[name] < 0) throw new Error(`${name} must be >= 0`);
  }
  if (out.work > out.count) throw new Error("--work cannot exceed --count");
  return out;
}

/** mulberry32 — deterministic, no deps. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hiInclusive) {
  return lo + Math.floor(rng() * (hiInclusive - lo + 1));
}

function pick(rng, arr) {
  return arr[randInt(rng, 0, arr.length - 1)];
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function composition(count, work) {
  const stopsDesired = work === 0 ? 0 : Math.min(work, Math.max(1, Math.round(work * 0.25)));
  const stops = work + stopsDesired > count ? Math.max(0, count - work) : stopsDesired;
  const rest = count - work - stops;
  const followUps = Math.min(rest, work * 2);
  const ciNoise = Math.min(rest - followUps, Math.round(count * 0.12));
  const chatter = rest - followUps - ciNoise;
  return { work, stops, followUps, ciNoise, chatter };
}

function isAllowlisted(threadId) {
  return (
    threadId.startsWith("feishu:eng:") ||
    threadId.startsWith("github:tornado1110/tigercat#")
  );
}

function isStopText(text) {
  return testPolicyRegex(STOP_PATTERN, text);
}

function isExplicitWork(text) {
  return testPolicyRegex(EXPLICIT_PATTERN, text);
}

function isChatterText(text) {
  return testPolicyRegex(CHATTER_PATTERN, text);
}

function isCiFailure(text) {
  return testPolicyRegex(CI_FAIL_PATTERN, text);
}

function assertPolicySamples() {
  const chatter = [
    ["morning", true],
    ["Thanks!", true],
    ["ok", true],
    ["Morning all", false],
    ["coffee break", false],
    ["OK thanks", false],
    ["sg", false],
    ["got it", false],
    ["sounds good", false],
    ["see you tomorrow", false],
    ["Have a good evening.", false],
    ["anyone around for lunch?", false],
    ["I am in, 12:30 works.", false],
  ];
  for (const [text, expected] of chatter) {
    if (isChatterText(text) !== expected) {
      throw new Error(`chatter label drifted from ${POLICY_VERSION}: ${JSON.stringify(text)}`);
    }
  }
  if (!isStopText("Stop, do only the seq regression test instead and leave the refactor to me.")) {
    throw new Error(`stop label drifted from ${POLICY_VERSION}`);
  }
  if (isExplicitWork("Please also document the default next to the flag in the README.")) {
    throw new Error(`explicit-work must not treat "please also" as a verb (${POLICY_VERSION})`);
  }
  if (!isExplicitWork("Please add a --json flag")) {
    throw new Error(`explicit-work label drifted from ${POLICY_VERSION}`);
  }
}

/**
 * Label one trigger given the current subscription map.
 * subscribers: Map<threadId, Array<{ home: string }>>
 * Returns { expect, nextSubscribers } — caller applies subscription changes
 * after recording the event (spawn adds; interrupt keeps subscriptions).
 */
function classify(event, subscribers) {
  const { thread_id: threadId, kind, is_bot, text } = event;
  const subs = subscribers.get(threadId) || [];
  const routeForSubs = () => {
    if (subs.length === 0) return "router";
    if (subs.length === 1) return `worker:${subs[0].home}`;
    return subs.map((s) => `worker:${s.home}`);
  };
  const withFanout = (expect) => {
    if (Array.isArray(expect.route) && expect.route.length > 1) {
      expect.fanout = expect.route.length;
    }
    return expect;
  };

  if (!isAllowlisted(threadId)) {
    return { filter: "ignore", route: null, spawns: false };
  }
  if (is_bot && (kind === "im.message" || kind === "pr.comment")) {
    return { filter: "ignore", route: null, spawns: false };
  }
  if (kind === "ci.result") {
    if (isCiFailure(text)) {
      if (subs.length > 0) {
        return withFanout({ filter: "respond", route: routeForSubs(), spawns: false });
      }
      return { filter: "candidate", route: "router", spawns: false };
    }
    return { filter: "ignore", route: null, spawns: false };
  }
  if (isStopText(text) && subs.length > 0) {
    return withFanout({
      filter: "respond",
      route: routeForSubs(),
      spawns: false,
      interrupt: true,
    });
  }
  if (isExplicitWork(text)) {
    if (subs.length > 0) {
      return withFanout({ filter: "respond", route: routeForSubs(), spawns: false });
    }
    return { filter: "respond", route: "router", spawns: true };
  }
  if (isChatterText(text)) {
    return { filter: "ignore", route: null, spawns: false };
  }
  if (subs.length > 0) {
    return withFanout({ filter: "respond", route: routeForSubs(), spawns: false });
  }
  return { filter: "candidate", route: "router", spawns: false };
}

function applySubscriptions(event, expect, subscribers, plannedSubscribe, workerByHome) {
  if (expect.spawns) {
    const home = event.thread_id;
    const threads = plannedSubscribe || [home];
    const worker = { home };
    workerByHome.set(home, worker);
    for (const t of threads) {
      const list = subscribers.get(t) || [];
      if (!list.some((w) => w.home === home)) list.push(worker);
      subscribers.set(t, list);
    }
    expect.subscribe = threads.slice();
  }
  // interrupt stops only the current turn; the Worker keeps its subscriptions (#7).
}

function buildEvents(rng, count, work) {
  const comp = composition(count, work);
  const events = [];

  // Home threads for each work item: even index Feishu, odd index GitHub.
  const workItems = [];
  for (let i = 0; i < work; i++) {
    const feishu = i % 2 === 0;
    const home = feishu
      ? `feishu:eng:task-${pad(i + 1, 2)}`
      : `github:tornado1110/tigercat#${200 + i}`;
    workItems.push({
      index: i,
      home,
      source: feishu ? "feishu" : "github",
      kind: feishu ? "im.message" : "pr.comment",
      // Scripted brain passes only this thread to spawn. Extra threads are M1.
      subscribe: [home],
      text: WORK_TEXTS[i % WORK_TEXTS.length] + (i >= WORK_TEXTS.length ? ` (task ${i + 1})` : ""),
    });
  }

  const key = () => rng();

  for (const item of workItems) {
    if (!isExplicitWork(item.text)) {
      throw new Error(`work text is not classified as explicit work: ${item.text}`);
    }
    events.push({
      role: "work",
      workIndex: item.index,
      sort: key(),
      source: item.source,
      kind: item.kind,
      thread_id: item.home,
      author: pick(rng, AUTHORS),
      is_bot: false,
      text: item.text,
      reply_to: null,
      plannedSubscribe: item.subscribe.slice(),
    });
  }

  // Follow-ups stay on the home thread. Cross-thread delivery is an M1 spec.
  const followTargets = [];
  for (let i = 0; i < comp.followUps; i++) {
    followTargets.push(workItems[i % Math.max(workItems.length, 1)]);
  }
  for (let i = 0; i < followTargets.length; i++) {
    const item = followTargets[i];
    events.push({
      role: "followUp",
      workIndex: item.index,
      afterWork: item.index,
      sort: 1, // rewritten below
      source: item.source,
      kind: item.kind,
      thread_id: item.home,
      author: pick(rng, AUTHORS),
      is_bot: false,
      text: FOLLOWUP_TEXTS[i % FOLLOWUP_TEXTS.length],
      reply_to: "parent", // resolved after ids exist; parent is the work event
    });
  }

  // Stops: last `stops` work items, on the home thread, after the spawn.
  // Interrupt keeps the subscription; it does not free the thread for a new spawn.
  for (let i = 0; i < comp.stops; i++) {
    const item = workItems[workItems.length - 1 - i];
    events.push({
      role: "stop",
      workIndex: item.index,
      afterWork: item.index,
      sort: 1,
      source: item.source,
      kind: item.kind,
      thread_id: item.home,
      author: pick(rng, AUTHORS),
      is_bot: false,
      text: STOP_TEXTS[i % STOP_TEXTS.length],
      reply_to: "parent",
    });
  }

  const chatterThreads = [
    "feishu:random:watercooler",
    "feishu:eng:general",
    "feishu:eng:tigercat",
    "github:tornado1110/tigercat#12",
    "github:tornado1110/tigercat#27",
    "github:tornado1110/tigercat#41",
  ];
  let botChatBudget = Math.min(Math.round(comp.chatter * 0.08), comp.chatter);
  for (let i = 0; i < comp.chatter; i++) {
    const asBot = botChatBudget > 0 && rng() < 0.5;
    if (asBot) botChatBudget -= 1;
    const threadId = pick(rng, chatterThreads);
    const source = threadId.startsWith("github:") ? "github" : "feishu";
    const kind = source === "github" ? "pr.comment" : "im.message";
    const is_bot = asBot;
    const author = is_bot ? (source === "github" ? BOT_GH : BOT_IM) : pick(rng, AUTHORS);
    const text = is_bot
      ? source === "github"
        ? "Thanks for the contribution!"
        : "I am online."
      : pick(rng, CHATTER_TEXTS);
    events.push({
      role: "chatter",
      sort: key(),
      source,
      kind,
      thread_id: threadId,
      author,
      is_bot,
      text,
      reply_to: null,
    });
  }

  const ciPrs = [
    "github:tornado1110/tigercat#12",
    "github:tornado1110/tigercat#27",
    "github:tornado1110/tigercat#41",
    "github:tornado1110/tigercat#58",
    "github:tornado1110/tigercat#87",
    "github:tornado1110/tigercat#128",
    "github:tornado1110/tigercat#101",
  ];
  for (let i = 0; i < comp.ciNoise; i++) {
    const threadId = pick(rng, ciPrs);
    const pr = threadId.slice(threadId.indexOf("#"));
    // About one in five is a failure. Exact rate still depends on the seed.
    const failed = rng() < 0.2;
    const text = failed
      ? `CI failed: unit tests on ubuntu-24.04 (tornado1110/tigercat${pr}).`
      : pick(rng, [
          `CI passed on tornado1110/tigercat${pr} (linux, macos, windows).`,
          `CI skipped: docs-only change on tornado1110/tigercat${pr}.`,
          `CI cancelled on tornado1110/tigercat${pr}.`,
        ]);
    events.push({
      role: "ci",
      sort: key(),
      source: "github",
      kind: "ci.result",
      thread_id: threadId,
      author: BOT_GH,
      is_bot: true,
      text,
      reply_to: null,
    });
  }

  // Assign sort keys so follow-ups and stops come after their parent work event.
  const workSort = new Map();
  for (const ev of events) {
    if (ev.role === "work") workSort.set(ev.workIndex, ev.sort);
  }
  for (const ev of events) {
    if (ev.afterWork == null && ev.afterWorks == null) continue;
    const parents = (ev.afterWorks || [ev.afterWork]).map((idx) => workSort.get(idx));
    const parent = Math.max(...parents);
    // Place after the parent(s). Follow-ups occupy the first half of a 1e-3
    // window; stops occupy the second half, so a stop cannot precede a
    // follow-up on the same Worker and accidentally cause a second spawn.
    if (ev.role === "stop") ev.sort = parent + 5e-4 + 1e-9 + rng() * 5e-4;
    else ev.sort = parent + 1e-9 + rng() * 5e-4;
  }

  events.sort((a, b) => a.sort - b.sort || a.role.localeCompare(b.role));
  if (events.length !== count) {
    throw new Error(`internal error: planned ${events.length} events, expected ${count}`);
  }
  return { events, comp, workItems };
}

function assignTimestamps(rng, events) {
  let t = START_TS;
  let burstLeft = 0;
  for (let i = 0; i < events.length; i++) {
    if (i === 0) {
      events[i].tsMs = t;
      continue;
    }
    if (burstLeft === 0 && rng() < 0.08 && i < events.length - 1) {
      burstLeft = randInt(rng, 2, 6);
    }
    if (burstLeft > 0) {
      t += randInt(rng, 180, 800);
      burstLeft -= 1;
    } else {
      t += randInt(rng, 5_000, 180_000);
    }
    events[i].tsMs = t;
  }
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function emit(events) {
  const subscribers = new Map();
  const workerByHome = new Map();
  const workEventIdByIndex = new Map();
  const out = [];
  const stats = {
    total: 0,
    spawns: 0,
    stops: 0,
    followUps: 0,
    ciNoise: 0,
    chatter: 0,
    filter: { ignore: 0, candidate: 0, respond: 0 },
    route: { router: 0, worker: 0, none: 0 },
    sources: { feishu: 0, github: 0 },
    kinds: {},
    interrupt: 0,
    fanout: 0,
  };

  const width = Math.max(4, String(events.length).length);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const id = `trg_${pad(i + 1, width)}`;
    if (ev.role === "work") workEventIdByIndex.set(ev.workIndex, id);
    let replyTo = ev.reply_to;
    if (replyTo === "parent") {
      replyTo = workEventIdByIndex.get(ev.workIndex) || null;
    }
    const record = {
      id,
      ts: toIso(ev.tsMs),
      source: ev.source,
      kind: ev.kind,
      thread_id: ev.thread_id,
      author: ev.author,
      is_bot: ev.is_bot,
      text: ev.text,
      reply_to: replyTo,
    };
    const expect = classify(record, subscribers);
    applySubscriptions(record, expect, subscribers, ev.plannedSubscribe, workerByHome);
    record.expect = expect;
    out.push(record);

    stats.total += 1;
    if (expect.spawns) stats.spawns += 1;
    if (expect.interrupt) stats.interrupt += 1;
    if (expect.fanout) stats.fanout += 1;
    if (ev.role === "followUp") stats.followUps += 1;
    if (ev.role === "ci") stats.ciNoise += 1;
    if (ev.role === "chatter") stats.chatter += 1;
    if (ev.role === "stop") stats.stops += 1;
    stats.filter[expect.filter] += 1;
    if (expect.route == null) stats.route.none += 1;
    else if (expect.route === "router") stats.route.router += 1;
    else stats.route.worker += 1;
    stats.sources[ev.source] += 1;
    stats.kinds[ev.kind] = (stats.kinds[ev.kind] || 0) + 1;
  }
  return { records: out, stats };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  assertPolicySamples();
  const rng = mulberry32(args.seed);
  const { events, comp } = buildEvents(rng, args.count, args.work);
  assignTimestamps(rng, events);
  const { records, stats } = emit(events);

  if (stats.total !== args.count) {
    throw new Error(`count mismatch: got ${stats.total}, expected ${args.count}`);
  }
  if (stats.spawns !== args.work) {
    throw new Error(`work/spawns mismatch: got ${stats.spawns} spawns, expected ${args.work}`);
  }
  if (stats.stops !== comp.stops || stats.followUps !== comp.followUps || stats.ciNoise !== comp.ciNoise || stats.chatter !== comp.chatter) {
    throw new Error(
      `composition mismatch: ${JSON.stringify({
        got: { stops: stats.stops, followUps: stats.followUps, ciNoise: stats.ciNoise, chatter: stats.chatter },
        expected: comp,
      })}`,
    );
  }
  if (stats.interrupt !== comp.stops) {
    throw new Error(`interrupt mismatch: got ${stats.interrupt} labeled stops, expected ${comp.stops}`);
  }
  for (const rec of records) {
    const subscribed = rec.expect.subscribe;
    if (subscribed && (subscribed.length !== 1 || subscribed[0] !== rec.thread_id)) {
      throw new Error(`${rec.id} subscribes outside its home thread`);
    }
    if (Array.isArray(rec.expect.route)) {
      throw new Error(`${rec.id} fans out; the M0 stream has one home thread per Worker`);
    }
  }

  for (const rec of records) {
    process.stdout.write(JSON.stringify(rec) + "\n");
  }

  const summary = {
    seed: args.seed,
    count: args.count,
    work: args.work,
    startTs: toIso(START_TS),
    planned: comp,
    actual: stats,
  };
  process.stderr.write(
    `generate.mjs: seed=${args.seed} count=${args.count} work=${args.work}\n` +
      `  planned: spawns=${comp.work} stops=${comp.stops} followUps=${comp.followUps} ciNoise=${comp.ciNoise} chatter=${comp.chatter}\n` +
      `  actual:  spawns=${stats.spawns} stops=${stats.stops} followUps=${stats.followUps} ciNoise=${stats.ciNoise} chatter=${stats.chatter}\n` +
      `  filter:  ignore=${stats.filter.ignore} candidate=${stats.filter.candidate} respond=${stats.filter.respond}\n` +
      `  route:   router=${stats.route.router} worker=${stats.route.worker} none=${stats.route.none}\n` +
      `  source:  feishu=${stats.sources.feishu} github=${stats.sources.github}\n` +
      JSON.stringify(summary) +
      "\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] && process.argv[1].endsWith("generate.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  }
}

export {
  parseArgs,
  mulberry32,
  composition,
  classify,
  isAllowlisted,
  isExplicitWork,
  isChatterText,
  isStopText,
  isCiFailure,
};
