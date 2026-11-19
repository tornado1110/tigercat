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
 * Schema and filter policy: README.md in this directory.
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

The filter policy used to label \`expect\` is documented in README.md.
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

const TASK_VERBS =
  "add|fix|implement|refactor|write|change|update|remove|delete|investigate|document|run|create|replace|move|rename|set|keep";
const RE_AT = /@tigercat\b/i;
const RE_PLEASE_VERB = new RegExp(String.raw`\bplease\s+(?:also\s+)?(?:${TASK_VERBS})\b`, "i");
const RE_START_VERB = new RegExp(String.raw`^(?:${TASK_VERBS})\b`, "i");
const RE_CI_FAIL = /\bfail(?:ed|ure)?\b/i;
const RE_CHATTER =
  /^(?:morning(?:\s+all)?|ok(?:\s+thanks)?|thanks|thank you|\+1|lol|haha|nice|sg|got it|sounds good|brb|see you tomorrow|coffee break|have a good evening\.?|anyone around for lunch\?|i am in, 12:30 works\.|what'?s for lunch\?|i am online\.|thanks for the contribution!|working on it\.)$/i;
const STOP_SET = new Set(STOP_TEXTS.map((s) => s.toLowerCase()));

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
  return STOP_SET.has(String(text).toLowerCase());
}

function isExplicitWork(text) {
  return RE_AT.test(text) || RE_PLEASE_VERB.test(text) || RE_START_VERB.test(text);
}

function isChatterText(text) {
  return RE_CHATTER.test(String(text).trim());
}

function isCiFailure(text) {
  return RE_CI_FAIL.test(text);
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
  const feishuHomes = [];
  for (let i = 0; i < work; i++) {
    const feishu = i % 2 === 0;
    const home = feishu
      ? `feishu:eng:task-${pad(i + 1, 2)}`
      : `github:tornado1110/tigercat#${200 + i}`;
    const item = {
      index: i,
      home,
      source: feishu ? "feishu" : "github",
      kind: feishu ? "im.message" : "pr.comment",
      subscribe: [home],
      text: WORK_TEXTS[i % WORK_TEXTS.length] + (i >= WORK_TEXTS.length ? ` (task ${i + 1})` : ""),
    };
    if (feishu) feishuHomes.push(item);
    workItems.push(item);
  }

  // First two Feishu work items share PR #128 (many-to-many).
  // The next Feishu work item, if any, gets a private PR for a simple cross-channel follow-up.
  const SHARED_PR = "github:tornado1110/tigercat#128";
  if (feishuHomes.length >= 2) {
    feishuHomes[0].subscribe.push(SHARED_PR);
    feishuHomes[1].subscribe.push(SHARED_PR);
  }
  if (feishuHomes.length >= 3) {
    feishuHomes[2].subscribe.push("github:tornado1110/tigercat#87");
  } else if (feishuHomes.length === 1) {
    feishuHomes[0].subscribe.push("github:tornado1110/tigercat#87");
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

  // Follow-ups: round-robin across work items. Some are cross-channel PR comments.
  const followTargets = [];
  for (let i = 0; i < comp.followUps; i++) {
    followTargets.push(workItems[i % Math.max(workItems.length, 1)]);
  }
  for (let i = 0; i < followTargets.length; i++) {
    const item = followTargets[i];
    const extraThreads = item.subscribe.filter((t) => t !== item.home);
    // Every third follow-up on a cross-subscribed Worker arrives on the extra Thread.
    // The first follow-up is reserved for the shared PR when that pair exists.
    const forceShared = i === 0 && feishuHomes.length >= 2;
    const useExtra = forceShared || (extraThreads.length > 0 && i % 3 === 0);
    const threadId = forceShared
      ? SHARED_PR
      : useExtra
        ? extraThreads[0]
        : item.home;
    const source = threadId.startsWith("github:") ? "github" : "feishu";
    const kind = source === "github" ? "pr.comment" : "im.message";
    events.push({
      role: "followUp",
      workIndex: item.index,
      afterWork: item.index,
      afterWorks: forceShared ? [feishuHomes[0].index, feishuHomes[1].index] : undefined,
      sort: 1, // rewritten below
      source,
      kind,
      thread_id: threadId,
      author: pick(rng, AUTHORS),
      is_bot: false,
      text: FOLLOWUP_TEXTS[i % FOLLOWUP_TEXTS.length],
      reply_to: "parent", // resolved after ids exist; parent is the work event
    });
  }

  // Stops: last `stops` work items, in the home thread, after the spawn.
  // Skipping the earliest items keeps the shared-PR pair (the first two
  // Feishu homes) alive so a later event on that PR can fan out to both.
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
