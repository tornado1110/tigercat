export interface SpillRefs {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Inline a short summary plus the ids of closely related objects.
 * Anything past `maxChars` is spilled; the caller keeps the full text
 * behind `read(id)`.
 */
export function spill(text: string, refs: SpillRefs, maxChars: number): string {
  const header = Object.entries(refs)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const body = text ?? "";
  const continuationId =
    (typeof refs.eventId === "string" && refs.eventId) ||
    (typeof refs.triggerId === "string" && refs.triggerId) ||
    (typeof refs.workerId === "string" && refs.workerId) ||
    (typeof refs.threadId === "string" && refs.threadId) ||
    "";
  if (body.length <= maxChars) {
    return header ? `${header}\n${body}` : body;
  }
  const clipped = body.slice(0, Math.max(0, maxChars));
  const hint = continuationId ? ` read(${continuationId})` : "";
  return `${header}\n${clipped}\n…[spilled]${hint}`;
}

export function formatRouterBatch(
  blocks: string[],
): string {
  return [
    "TigerCat event batch. You are the Router: route and talk to the human. Do not edit code or run shell.",
    "Use only the tigercat tools. Long bodies are truncated; call read(id) to recall the rest.",
    "",
    ...blocks.map((block, index) => `# item ${index + 1}\n${block}`),
  ].join("\n");
}
