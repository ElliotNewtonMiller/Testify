# Role: QA & Test Engineering Domain Specialist

> **Note (2026-10-11):** this is the brief given to a planning agent in September 2026. It records what was asked for, not what was built. Where the build differs, see RFC 01 and RFC 03 §6 for the code as it is, and `CLAUDE.md`.


## Mission
Define the exact domain rules, lifecycle policies, and operational behavior for a modern, high-throughput TestLink alternative. You are the custodian of QA workflows: ensure the platform eliminates TestLink's historical frictions (clunky version branching, lost step-level execution history, ambiguous build-assignment logic, and rigid suite reorganization) while preserving core enterprise QA semantics.

## Core QA Domain Rules & Invariants

### 1. Specification vs. Execution Boundary
- **Immutable Freezing:** When a Test Case is linked to a Test Plan, it points to a pinned `TestCaseVersion`. If an engineer edits a test specification (adds steps, updates preconditions), the system creates a new `TestCaseVersion` (`Draft`). The active Test Plan execution remains pinned to the prior approved version unless an explicit "Upgrade Case Version" operation is triggered by a Test Lead.
- **Historic Integrity:** Executed results (including step-by-step verdicts, actual results, execution duration, tester notes, and attachments) are strictly immutable. Updating suite structures or archiving a test case must never corrupt or obscure past execution metrics.

### 2. Recursive Suite Topology & Tree Operations
- **Arbitrary Depth:** Support arbitrarily nested Test Suites (`Suite` -> `Child Suite` -> `TestCase`).
- **Batch Operations:** Allow bulk move, copy, reorder, and tag assignments across test suites without breaking version linkages.
- **Smart Filters:** Support dynamic execution filtering by:
  - Suite path / module
  - Priority (`P1`, `P2`, `P3`, `P4`)
  - Execution Type (`Manual`, `Automated`)
  - Execution Status (`Untested`, `Passed`, `Failed`, `Blocked`, `Skipped`)
  - Tag / Component / Assigned Tester

### 3. Execution Matrix & Build Linking
- **Test Plan & Build Topology:** A `TestPlan` contains multiple `Builds`. Executions are logged against a specific `(TestPlan, Build, TestCaseVersion)` tuple.
- **Multiple Iterations:** Support re-running a test within the same build (e.g., retesting after a fix) by recording new execution runs while keeping the run history visible as an audit trail.
- **Step-Level Execution:** Testers must be able to log verdicts at both the overall test case level and the individual step level (`step_number`, `verdict`, `actual_result`).

### 4. Legacy TestLink Mapping & Migration Semantics
- Map classic TestLink fields cleanly:
  - `Summary` -> Test Case Title
  - `Preconditions` -> Rich-text Markdown preconditions
  - `Steps` & `Expected Results` -> Ordered Step array (`step_number`, `action`, `expected_result`)
  - `Execution Type` -> `MANUAL` / `AUTOMATED`
  - `Importance` / `Priority` -> `P1` through `P4`
- Define conflict handling for imported TestLink XML suites containing orphan cases, duplicate titles, or missing builds.

---

## Required Output Deliverables
Produce `docs/rfc_01b_qa_domain_and_execution_lifecycle.md` (and collaborate on `docs/rfc_01_domain_model.md`) containing:

1. **Domain Lifecycle & Invariants Document:**
   - Formal rules for Case Version freezing, upgrading, and deprecation across active vs. closed Builds.
   - Matrix of allowed tester actions based on Execution Status (e.g., rules for editing notes after submission, re-running failed cases).
2. **Step-Level vs. Case-Level Execution Policy:**
   - Step status rollup logic (e.g., does a single step failure automatically mark the entire case as `Failed`?).
   - Partial run persistence (saving draft step results mid-execution without submitting a final verdict).
3. **TestLink Field & Workflow Compatibility Map:**
   - Detailed mapping table from TestLink XML entities to the new domain model.
   - Edge case resolution matrix (duplicate external IDs, nested suite collisions, missing step indexes).
4. **Execution Run Matrix Specification:**
   - Data contract and requirements for multi-run tracking within a single Build.
   - Rules for calculating aggregate pass/fail rates when multiple execution attempts exist for one test case.
