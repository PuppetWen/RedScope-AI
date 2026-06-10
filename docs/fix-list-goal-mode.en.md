# Fix List and Goal Mode

Date: 2026-06-10

## Fixes

- Fixed the Auto mode status in `autonomy status --deep`: when an unavailable reason exists, the status now reports `unavailable` instead of showing `available` together with a contradictory `reason=model` or similar reason.
- Fixed the Chrome MCP bridge workspace package missing the required entrypoint during install and path resolution, which broke `postinstall` and resolver tests. A RedScope-scoped workspace shim was added and made release-ready.
- Added focused pure-function tests for Auto mode availability formatting to reduce regression risk.

## Goal Mode

- Added the `/goal` interaction: after selecting or typing `/goal`, the prompt area shows a pending goal prompt; the user's next submitted input becomes the session goal.
- The active goal stays pinned above the input box and is marked as `Goal`; RedScope keeps making progress automatically until the goal is genuinely complete.
- Starting a goal injects hidden model-visible metadata instead of exposing goal-control instructions as normal chat content.
- While the goal is incomplete, each completed turn schedules a hidden `later` priority continuation prompt. User input remains higher priority and is not preempted by goal continuations.
- The right side of the pinned goal shows `/goal cancel`. Running `/goal cancel`, `/goal stop`, or `/goal off` cancels the goal. Cancellation does not abort the currently running stage; the current stage finishes naturally, and no further goal continuation is scheduled.
- `/goal <objective>` remains supported for direct goal startup, along with `/goal status`, `/goal done`, and `/goal complete`.
- Goal mode only auto-completes when the model emits the current goal's exact `<goal_complete id="..." />` tag; stale completion tags from older goals are ignored.
