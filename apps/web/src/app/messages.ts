// Messages shown in more than one place, kept together so they stay worded the same.

export const SESSION_ENDED_NOTICE = "Your sign-in has ended. Please sign in again.";

// Messages for the yellow "Not permitted" banner in Execute mode.
export const RUN_DENIED_MESSAGE =
  "Your role can't record executions in this project, so that result was not saved. Ask an administrator if you need to.";
export const OVERWRITE_DENIED_MESSAGE =
  "This test case already has a result in this run, and your role can't change existing results (EXECUTE_OVERWRITE), so that result was not saved. Ask a test lead or administrator if it needs to change.";

// Why a result can't be recorded right now (see verdictBlockReason).
export const RUN_CLOSED_MESSAGE = "This run is closed. Open it to record results.";
// No run in the plan (or none selected) -- there's nothing to record a result against.
export const NO_RUN_MESSAGE = "Create a test run to record test execution.";
// A case removed from the plan (after this run recorded its result) is read-only.
export const REMOVED_CASE_MESSAGE = "This test case was removed from the plan. Its result is kept, but no new results can be recorded. Add it back to the plan to test it again.";
