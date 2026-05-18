# Checkpoint Follow-ups

## After Checkpoint 3

- Keep the command input fixed and visible when the raw transcript fills the
  page. The player should never need to scroll back down to type.

## Checkpoint 5 Observations

- Track hidden-object omniscience leaks in narration. The Living Room game-data
  slice includes both `RUG` and `TRAP-DOOR`, but the trap door should not be
  mentioned before the rug has been moved. A likely mitigation is to label
  covered, hidden, or obscured objects in context and instruct narration not to
  mention them until the engine reveals them.
- Track hidden-object omniscience leaks from container contents. The static room
  slice can list objects physically inside closed containers, such as `LUNCH`
  and `GARLIC` inside the closed `SANDWICH-BAG`. v0.5 polish now filters
  visibility by containment and simple runtime open/closed state, but this
  should receive broader validation for nested containers and parser messages.
- Intent mapping now uses exact API model ID
  `nvidia/qwen/qwen3-next-80b-a3b-instruct`; narration remains on
  `aws/anthropic/bedrock-claude-sonnet-4-6` for voice quality.

## Checkpoint 6 Observations

- Canonical v3 Zork does not recognize `undo` or `$undo` as parser commands.
  The spike implements single-level undo in the browser wrapper by restoring a
  fresh engine and replaying the committed command history up to the pre-turn
  snapshot. This preserves the required player-facing behavior while staying
  compatible with the canonical story file.
- Zork's built-in death path resurrects the player to the Forest after printing
  the death banner. Zorkish treats the engine death as terminal until the
  overlay prompt resolves, preserving the actual death location for narration,
  the Wiki death record, and undo.
- Run resumption is implemented with replay-backed save blobs in the existing
  `saves` store because the current Bocfel/Emglken wrapper does not expose a
  true Quetzal save/restore API. On load, the app resumes the most-recent
  non-ended gameplay run with at least one turn; if none exists, it waits until
  the first submitted command to create a new run, preventing zero-turn refresh
  artifacts. A second tab resumes the same IndexedDB run; conflict handling is
  v1 work.

## V1 Follow-ups

- Replace command-history replay saves with true Quetzal save/restore once the
  engine wrapper exposes it, or switch to a wrapper that does. Replay-backed
  saves are acceptable for v0.5 because Zork I replay is effectively
  deterministic for single-player use, but long runs will get slower to restore
  and thief scheduling should be watched for replay divergence.
