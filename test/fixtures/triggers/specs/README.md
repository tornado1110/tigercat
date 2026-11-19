# Not M0 replay

These JSONL files are specifications. They are not inputs that
`mismatches()` is expected to accept under the M0 harness settings in
`../README.md`.

- `m1/` keeps cross-thread subscription labels. The scripted brain
  subscribes only the home thread passed to `spawn`. Cross-channel
  continuity and a shared PR feeding two Workers are M1, not current
  behavior.
- `lifecycle/kill-worker.jsonl` keeps abnormal-exit semantics: the Worker
  unsubscribes from every Thread, and the next explicit request spawns
  again. Replay cannot perform that exit, and it does not read
  `unsubscribe_all`. The labels stay as specified.
- `batching/burst-batching.jsonl` keeps `batch` ids and a fifth overlapping
  spawn. `mismatches()` does not read `batch`. Default `maxConcurrency` is
  4. Per-event `settle()` does not leave the router mid-turn.

Do not edit these files so a current replay reports zero mismatches.
That would describe the wrong path.
