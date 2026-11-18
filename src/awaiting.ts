/**
 * `awaitingInput` is a TigerCat annotation on `worker.turn_end`.
 * It is not an ACP field and it is not read from ACP `_meta`.
 * The agent's `stopReason` is stored unchanged (a question still ends
 * with `end_turn`). The flag is derived only from that reason plus the
 * text the agent actually produced.
 */
export function deriveAwaitingInput(stopReason: string, text: string): boolean {
  if (stopReason !== "end_turn") return false;
  const body = text.trim();
  if (!body) return false;
  if (/\?\s*$/.test(body)) return true;
  return /\b(awaiting input|need(?:s|ed)? (?:more )?(?:input|detail|information)|please (?:clarify|confirm|provide|tell me)|waiting for (?:your|you)|which (?:one|option|file|name))\b/i.test(
    body,
  );
}
