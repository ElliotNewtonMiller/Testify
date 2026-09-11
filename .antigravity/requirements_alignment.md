# Phase 1: Requirements Alignment & Intake Decisions

**Document Status:** Approved & Locked  
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
  - Any attempt to POST/PUT new execution results or modify verdicts against a closed build/plan returns **HTTP 422 Unprocessable Entity** (`BUILD_CLOSED` / `PLAN_LOCKED`).

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

---

## 4. Multi-Format Ingestion & Extensible Parser Engine

- **Format Flexibility:**
  - Ingestion engine uses an **Extensible Parser Plugin Architecture**.
  - **Built-in Out of the Box Formats:**
    1. TestLink XML (`<testsuite>`, `<testcase>`, `<steps>`)
    2. Native TestLink-Next JSON Schema (`.json` test suite bundles)
    3. Standard CSV tabular spec sheets (`.csv`)
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
  - Includes a mandatory **Dry-Run Inspection Diff** (`POST /api/v1/imports/dry-run`) prior to applying mutations.
