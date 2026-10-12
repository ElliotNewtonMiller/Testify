# Phase 1: Requirements Alignment & Intake Decisions

**Document Status:** Approved & Locked intake decisions; "As built" notes added 2026-10-11 where the code differs  
**Date:** September 8, 2026  
**Session Type:** `/grill-me` Phase 1 Intake  

---

## 1. Data Retention & Archival Thresholds

- **Execution History Purge:**
  - Default purge/deletion threshold: **1 year (365 days)**.
  - Purge threshold is **admin-modifiable** per environment/project.
- **Log Snippets & Attachments Storage:**
  - Stored **out-of-band** (not bloat SQL database tables).
  - **Storage Architecture:** Dual Local Filesystem + S3 Abstraction layer.
    - Dev / SQLite mode: Local filesystem directory.
    - Production / PostgreSQL mode: MinIO or AWS S3-compatible bucket driver.
- **Audit Log Retention:**
  - Audit events (`audit_logs` table) are stored in the primary database with **no automatic deletion**.
  - Append-only forever unless manually purged by a System Administrator via CLI/DB utility.
- **As built:**
  - Audit logs are append-only as decided, enforced by database triggers.
  - There's no purge: results are kept forever.
  - There are no attachments or out-of-band storage; failure messages and stack traces are stored on the result.
  - SQLite was dropped (2026-09-11): development uses in-memory PGlite and production uses PostgreSQL, and the storage choice will be independent of the database.

---

## 2. Suite & Case Versioning Mechanics

- **Suite-Level Versioning:**
  - Suite tree hierarchy is **mutable** across historical Test Plans. Reordering, moving, or renaming suites does not force a suite-tree snapshot, keeping tree navigation fast and flexible.
- **Frozen Snapshot Mechanics:**
  - When a `TestPlan` or `Build` is locked or archived, the associated `TestCaseVersion` snapshots (including custom field state) are permanently frozen to prevent historical test execution reports from mutating.
- **Draft vs. Production Lifecycle:**
  - **Default Rule:** `Draft` test cases **cannot** be added to active `TestPlans` (only `Approved` versions allowed).
  - Admin settings provide a toggle to override this constraint per project if draft testing is explicitly permitted.
- **Locked Plan Operational Restrictions:**
  - **Read-Only Lock:** Completed execution results remain fully viewable and exportable.
  - Any attempt to POST/PUT new execution results or modify verdicts against a closed build/plan returns **HTTP 422 Unprocessable Entity** (`BUILD_CLOSED` / `PLAN_LOCKED`; as built, the codes are `RUN_CLOSED` / `PLAN_LOCKED`).
- **As built:**
  - Each plan pins every case to a version; past results keep the version they ran against.
  - Approving a new version moves the pin in ACTIVE plans only; LOCKED and ARCHIVED plans keep theirs.
  - **Custom field values are not frozen:** they belong to the case, aren't versioned, and results don't record them. Decided with Elliot on 2026-10-01.
  - The draft toggle is the project setting `allow_draft_plan_linking`, with no UI yet.
  - Closed runs and locked or archived plans return 422 as decided. Results are never edited; a new result becomes the latest.

---

## 3. Hotkey Ergonomics & Focus Controls

- **Activation Context:**
  - Hotkeys (`p` Passed, `f` Failed, `b` Blocked, `s` Skipped, `j` Next, `k` Prev) are active **only** when key focus is inside the active Test Execution Pane.
  - A prominent visual toggle button in the Execution Pane displays the active/inactive state of hotkeys.
- **Collision Protection (No `Esc` Required):**
  - Selecting or focusing any input element (text field, textarea, search bar, dropdown) **automatically deactivates** single-key hotkeys without requiring the user to press `Esc`.
  - Hotkeys automatically re-engage when focus returns to the execution pane container.
- **Keybindings Scope:**
  - System-wide default keybinding matrix standard across all user profiles for v1.
- **As built:**
  - Verdict hotkeys work anywhere in **Execute mode**, not only when the execution pane has focus, and are refused in Spec mode. `j`/`k` work in both modes.
  - The hotkey badge in the execution pane shows the state and turns hotkeys on and off.
  - Typing protection works as decided.
  - See RFC 02 §4 for the full table.

---

## 4. Multi-Format Ingestion & Extensible Parser Engine

- **Format Flexibility:**
  - Ingestion engine uses an **Extensible Parser Plugin Architecture**.
  - **Built-in Out of the Box Formats:**
    1. TestLink XML (`<testsuite>`, `<testcase>`, `<steps>`)
    2. Native Testify JSON Schema (`.json` test suite bundles)
    3. Standard CSV tabular spec sheets (`.csv`)
  - **As built:** also JUnit XML and TestRail CSV.
- **Duplicate Reconciliation Engine:**
  - Interactive session modal prompts the importer upon encountering duplicate suite/case titles.
  - Includes an **"Apply decision to all future duplicates"** toggle per session.
  - Actions supported: `Create New Copy`, `Overwrite Existing`, `Version Up Existing`, `Skip`.
- **Custom Field Pre-Import Setup:**
  - Unknown custom fields trigger a pre-import configuration modal allowing the user to map each field:
    - `Drop` (ignore column/node)
    - `Auto-Create Definition` (register as a new custom field definition)
    - `Route to Existing Custom Field` (map incoming key to existing field)
- **Large File Ingestion Pipeline:**
  - Stream-parsed background job with real-time progress bar.
  - Includes a mandatory **Dry-Run Inspection Diff** (`POST /api/v1/imports/dry-run`; as built, `POST /api/v1/projects/{projectId}/imports/dry-run`) prior to applying mutations.
- **As built:**
  - The import wizard has the dry run, custom-field mapping (drop, create, or map to an existing field) and duplicate handling.
  - Duplicates take one action for the whole import; per-case choices are possible through the API only, and the "apply to all future duplicates" toggle has no effect.
  - There's no background job or progress bar: files up to 50 MB are imported in one request (RFC 03 §6).
