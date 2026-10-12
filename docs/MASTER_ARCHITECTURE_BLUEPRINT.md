# Master Architecture Blueprint: Testify

**Document Status:** Overview of the architecture, updated 2026-10-11 to match what's built
**Date:** September 8, 2026
**Synthesized From:**
- [`00_requirements_alignment.md`](./00_requirements_alignment.md)
- [`rfc_01_domain_model.md`](./rfc_01_domain_model.md): domain model, schema, state machines
- [`rfc_02_ux_density_and_hotkeys.md`](./rfc_02_ux_density_and_hotkeys.md): layout, density, hotkeys
- [`rfc_03_api_and_xml_contracts.md`](./rfc_03_api_and_xml_contracts.md): API (original design), CI results, import
- [`rfc_04_rbac_security_matrix.md`](./rfc_04_rbac_security_matrix.md): permissions, tokens, audit, threat model

This blueprint gives the whole picture in brief. It links to the RFCs for detail rather than repeating them, so there's one place to keep each fact up to date. For how to run and change the code, see `CLAUDE.md`; for deployment, [`deployment.md`](./deployment.md).

---

## 1. Executive Summary & System Architecture

Testify is a self-hosted test management and execution platform that replaces TestLink. It removes TestLink's frictions (slow page reloads, fragmented navigation, lost step history, clunky versioning, brittle migrations) while keeping its model: **Projects, Test Suites, Test Cases, Test Case Versions, Test Plans, Test Runs, Results and Custom Fields**.

```
+---------------------------------------------------------------------------------------------------+
|                                     WEB APP (React + Vite, apps/web)                              |
|  3-pane workspace (suite tree | case list / queue | detail), Spec and Execute modes, Reports view |
|  32px rows, virtualized lists, permission-gated hotkeys (p f b s j k / [ ] Ctrl+Enter)            |
+-------------------------------------------------|-------------------------------------------------+
                                                  | HTTPS, JSON (session cookie + CSRF header)
                                                  v
+---------------------------------------------------------------------------------------------------+
|                                   API SERVER (Fastify, apps/server)                               |
|  One process: REST API (/api/v1), MCP endpoint (/mcp), and the built web app                     |
|  Auth: server-side sessions | project-bound API tokens (tf_ci_...) | per-project permissions      |
|  Problem-details errors | rate limits | JSON request log | /api/v1/health | scheduled report email |
|  +-------------------------------------+       +-----------------------------------------------+  |
|  | Spec, plans, runs, results, reports |       | Import (TestLink XML, JUnit XML, JSON, CSV,   |  |
|  | (routes + services)                 |       | TestRail CSV) and export (JSON, CSV)          |  |
|  +-------------------------------------+       +-----------------------------------------------+  |
|  Domain logic without a database: packages/core (parsers, reports, permissions, custom fields)    |
+-------------------------------------------------|-------------------------------------------------+
                                                  | Kysely (packages/db: migrations, repositories)
                                                  v
+---------------------------------------------------------------------------------------------------+
|                    PostgreSQL (production)  |  PGlite, in-memory (development and tests)          |
|  Tracked migrations | FK rules | append-only audit triggers | version pinning per plan             |
|  Attachments / out-of-band storage (IStorageProvider): not built                                  |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. State Machines

Details and diagrams are in [RFC 01 §7](./rfc_01_domain_model.md). In brief:
- **Test case versions:**
  - DRAFT → APPROVED → DEPRECATED, and Restore goes back to APPROVED.
  - Editing an approved case creates a new DRAFT version.
  - Approving re-pins ACTIVE plans to the new version. Only approved cases can join plans (unless `allow_draft_plan_linking` is on).
- **Test plans:** ACTIVE, LOCKED or ARCHIVED.
- **Test runs:** OPEN or CLOSED, closing themselves the first time every case has a result.
- **Writes:** results to a closed run or a locked or archived plan are refused with HTTP 422 (`RUN_CLOSED` / `PLAN_LOCKED`).
- **Results are append-only:** "untested" means no result yet, and the latest result is the verdict. Recording over an existing result needs `EXECUTE_OVERWRITE`.
- **Hotkeys:** verdict keys only work in Execute mode. They pause while a text box has focus, and are permission-gated ([RFC 02 §5](./rfc_02_ux_density_and_hotkeys.md)).

---

## 3. Data Model

The schema is summarized table by table in [RFC 01 §3](./rfc_01_domain_model.md); the migrations in `packages/db/src/migrations/` are the source of truth.

The core chain is:

project → suites (a tree) → cases → versions → steps

with plans pinning case versions (`test_plan_cases`, retired rather than deleted once a case has results) and runs (`test_runs`) holding results (`test_results`, with `test_step_results`).

Around that sit:
- custom fields: definitions, options and typed values;
- access: users, global and project roles, role templates and permission overrides;
- sign-ins and API tokens: sessions, `api_tokens`;
- the append-only audit log;
- system settings and report schedules.

---

## 4. Workspace & Hotkeys

See [RFC 02](./rfc_02_ux_density_and_hotkeys.md). In brief:
- **Layout:** three panes with draggable dividers (default 280px / 420px / the rest), in Spec or Execute mode, plus a full-width Reports view.
- **Density:** 32px queue rows and 28px tree rows, with virtualized lists.
- **Keyboard:** the hotkey table is RFC 02 §4. Typing in a text box never triggers a hotkey.

---

## 5. API, CI Results & Import

- **REST API:** under `/api/v1`. Lists and creation sit under the parent and each item has its own address (`/projects/{id}/plans`, `/plans/{id}`, `/runs/{id}/results`); `PATCH` for partial updates; 201/200/204; problem-details errors. The conventions, route map and error codes are in [RFC 03 §1-4](./rfc_03_api_and_xml_contracts.md). There's no OpenAPI spec yet ([api_roadmap.md](./api_roadmap.md) step 3).
- **Reports and MCP:** a catalog-driven reports API and a read-only MCP endpoint for agents ([reports_api_and_mcp.md](./reports_api_and_mcp.md)).
- **CI results:** `POST /api/v1/runs/{runId}/results/batch`, up to 5,000 results per request in one transaction, with an all-or-nothing option ([RFC 03 §3](./rfc_03_api_and_xml_contracts.md)).
- **Import:** dry run then execute, with interactive custom-field mapping and duplicate handling, up to 50 MB per file ([RFC 03 §6](./rfc_03_api_and_xml_contracts.md)).
- **Export:** suite and case definitions, or a run's results, as JSON or CSV.
- **Not built:** attachments and storage, the retention purge, webhooks ([RFC 03 §5, §7.3](./rfc_03_api_and_xml_contracts.md)).

---

## 6. Permissions, Security & Audit

See [RFC 04](./rfc_04_rbac_security_matrix.md). In brief:
- **Permissions:** 19 permission keys and six built-in, editable role templates (Admin, Test Lead, Tester, Automation Service, Viewer, No Access).
- **Evaluation:** per project. A project role replaces the global role there, and overrides have the final say. Admin changes are guarded against escalation and against removing the last admin.
- **Sign-ins:** server-side sessions (8 hours idle, 7 days at most), an HttpOnly cookie for the web app, account lockout and per-address limits.
- **API tokens:** `tf_ci_...`, shown once, stored as a SHA-256 digest, bound to one project, and capped by the issuer's current permissions.
- **Audit log:** append-only, with the real client address and User-Agent.

---

## 7. Requirement Verification Matrix

| # | Requirement | Rule | Where | Status |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Data retention** | Results purged after a configurable period (default 365 days). | RFC 01 §2.5 | Not built: results are kept forever. |
| 2 | **Attachments** | Out-of-band storage via `IStorageProvider` (local disk / S3). | RFC 03 §5 | Not built. |
| 3 | **Audit retention** | Append-only; no automatic deletion; triggers block UPDATE and DELETE. | RFC 04 §5 | Built and tested (`MUTATION_DENIED`). |
| 4 | **Suite mutability** | The suite tree can change without affecting past results. | RFC 01 §2.2 | Built. |
| 5 | **Version pinning** | Plans pin case versions; editing a case doesn't change past results. Custom field values are not frozen (decided). | RFC 01 §2.3 | Built and tested. |
| 6 | **Draft rule** | Only approved cases can join plans unless the project allows drafts. | RFC 01 §2.3 | Built; the setting has no UI. |
| 7 | **Closed / locked writes** | Results refused with HTTP 422 (`RUN_CLOSED` / `PLAN_LOCKED`). | RFC 01 §2.4 | Built and tested. |
| 8 | **Hotkey scope** | Verdict hotkeys only in Execute mode, with a status badge. | RFC 02 §4, §6 | Built. |
| 9 | **Input protection** | Typing in a text box never triggers a hotkey (no `Esc` needed). | RFC 02 §5.3 | Built and tested. |
| 10 | **Hotkey permissions** | Verdict hotkeys need `EXECUTE_RUN` (and `EXECUTE_OVERWRITE` to record over a result). | RFC 02 §5.3 | Built and tested; the server checks too. |
| 11 | **Multi-format import** | Pluggable parsers for TestLink XML, JSON and CSV. | RFC 03 §6.1 | Built, plus JUnit XML and TestRail CSV. |
| 12 | **Import reconciliation** | Custom-field mapping and duplicate handling before importing. | RFC 03 §6.4 | Built. |
| 13 | **Streaming import** | 100 MB+ files parsed in bounded memory. | RFC 03 §6.3 | Not built: 50 MB cap, held in memory. |
| 14 | **Operational integrity** | The full workflow (spec, plan, results, permissions, audit) runs on the one Postgres-compatible dialect. | RFC 01 §4 | Built; tested on PGlite and, in CI, on PostgreSQL. |
