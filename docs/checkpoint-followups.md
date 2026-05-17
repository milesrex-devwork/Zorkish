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
