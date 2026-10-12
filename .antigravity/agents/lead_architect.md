# Role: Lead System Architect

> **Note (2026-10-11):** this is the brief given to a planning agent in September 2026. It records what was asked for, not what was built. Where the build differs, see RFC 01 for the code as it is, and `CLAUDE.md`.


## Mission
Design the foundational storage abstraction, data models, state machines, and relational architecture for a modernized, high-performance TestLink alternative. The platform must eliminate TestLink's historical pain points—slow page loads, fragmented tree navigation, clunky test execution workflows, and brittle schema upgrades—while strictly maintaining TestLink's proven mental models (Test Projects, Test Suites, Test Cases, Test Plans, Builds, and Executions).

Crucially, the architecture must treat **Admin Extensibility** as a first-class citizen: administrators must be empowered to customize the platform to fit diverse enterprise workflows, including dynamic custom fields/attributes on test entities, configurable status workflows, and an open, fine-grained permission assignment engine for arbitrary users and ad-hoc roles.

## Core Architectural Constraints

### 1. Postgres-Compatible Database Layer
- **Zero Lock-In, One Dialect:** The platform runs on a single Postgres-compatible SQL dialect everywhere: a zero-config, embedded `PGlite` (WASM Postgres) instance for local evaluation/offline runners, and a real multi-user PostgreSQL server for production/team deployments, selected purely by whether a `DATABASE_URL` connection string is supplied.
- **Driver Abstraction:** Utilize a strongly typed query builder layer (Kysely). Avoid Postgres-specific niceties that add friction without real benefit (e.g. prefer string constants with `CHECK` constraints over native `ENUM` types, for simpler migrations), but there is no second dialect to normalize against.
- **Primary Keys:** Standardize on UUIDv7 across all entities for monotonic, time-ordered indexing and client-side safe ID generation.
- **Foreign Keys & Indices:** Enforce strict cascade rules (`ON DELETE RESTRICT` for historical runs, `CASCADE` for transient drafts). Include index strategies specifically optimized for recursive tree lookups, custom field filtering, and bulk status writes.

### 2. Domain Separation: Test Specification vs. Test Execution
- **Specification (Mutable):** `Project` -> `TestSuite` (hierarchical) -> `TestCase` -> `TestCaseVersion` -> `TestStep`.
- **Execution (Immutable Snapshot):** `TestPlan` -> `Build` -> `TestRunExecution`.
- **Snapshot Isolation Rule:** When a Test Plan includes a Test Case, it binds to a frozen `TestCaseVersion` (including frozen custom field snapshots). Editing a Test Case specification or modifying custom field values must never mutate or invalidate prior completed run results.

### 3. Tree Hierarchy & Recursive Structures
- Implement an efficient tree representation for Test Suites and Cases (Adjacency List with materialized path or recursive CTE support) that allows instantaneous retrieval of subtrees without N+1 query bottlenecks.

### 4. Admin Customization & Dynamic Field Engine
- **Entity Extensibility:** Admins must be able to attach arbitrary custom fields to `TestCaseVersion`, `TestSuite`, `Execution`, or `Project`.
- **Supported Field Types:** `STRING`, `NUMBER`, `BOOLEAN`, `DATE`, `SINGLE_SELECT`, `MULTI_SELECT`, `MARKDOWN_TEXT`.
- **Storage Strategy:** Implement a hybrid design using a strongly typed metadata definition table (`custom_field_definitions`) paired with structured JSON storage (serialized JSON text columns via the Kysely driver layer) or an EAV mapping layer.
- **Validation & Scoping:** Custom fields can be scoped globally or to specific projects, with configurable constraints (`required`, `default_value`, `allowed_options`, `regex_pattern`).

### 5. Flexible RBAC & Miscellaneous User Permissions
- **Arbitrary Custom Roles:** Admins can define custom role templates with arbitrary combinations of atomic permission keys (e.g., `SPEC_EDIT`, `RUN_EXECUTE`, `FIELD_ADMIN`, `AUDIT_VIEW`).
- **Direct User Overrides:** Support granular permission assignments directly to individual users on a per-project or system-wide basis, without forcing them into a rigid, pre-baked role.
- **Inheritance & Conflict Model:** Clear precedence algorithm (User Direct Grant > Project Role > Global Role) for permission evaluation.

### 6. High-Throughput Batch Writes & Concurrency
- Design atomic transactional boundaries for bulk execution updates (e.g., `/executions/batch`) to support CI/CD runners reporting hundreds of test results simultaneously without table-level locking.

---

## Required State Machines & Enums

### 1. Test Case Version Lifecycle (Configurable Transitions)
- Default: `Draft` -> `In_Review` -> `Approved` -> `Deprecated`
- Invariant: Only `Approved` versions can be assigned to active `TestPlans`.
- Extensibility: Provide schema support for admin-defined approval gates (e.g., requiring dual-signoff before moving from `In_Review` to `Approved`).

### 2. Test Plan & Build Status
- `TestPlan`: `Active`, `Locked`, `Archived`
- `Build`: `Open`, `Closed` (runs cannot be written to closed builds)

### 3. Execution Run States & Verdicts
- Default Execution Status: `Untested`, `In_Progress`, `Completed`, `Aborted`
- Default Result Verdict: `Passed`, `Failed`, `Blocked`, `Skipped`
- Extensibility: Allow admin-configured custom verdict options (e.g., `Retest_Required`, `Known_Issue`) mapped to core reporting categories.

---

## Required Output Deliverables
Produce `docs/rfc_01_domain_model.md` containing:

1. **Complete Relational Schema & ERD (Mermaid.js):**
   - Core tables: `projects`, `test_suites`, `test_cases`, `test_case_versions`, `test_steps`, `test_plans`, `builds`, `test_plan_cases`, `executions`, `execution_steps`, `audit_logs`.
   - Admin & Extensibility tables: `custom_field_definitions`, `custom_field_options`, `custom_field_values`, `roles`, `permissions`, `role_permissions`, `user_project_roles`, `user_permission_overrides`, `system_settings`.
   - Exact column definitions, nullability, foreign key actions, and index specifications.
2. **Migration & Schema Versioning Spec:**
   - Migration strategy for the single Postgres-compatible dialect (PGlite locally, real PostgreSQL in production), including rollback behavior.
   - Type & column conventions (datetime handling, JSON storage for custom fields, primary key format).
3. **Custom Field & Metadata Storage Architecture:**
   - Detailed trade-off analysis and technical decision for Custom Field storage (JSON column vs. EAV vs. hybrid).
   - Snapshot freezing mechanics: How custom fields are immutably captured at execution time.
4. **Arbitrary Permission Resolution Algorithm:**
   - Formal precedence flow chart for evaluating system, project, role, and ad-hoc user permission grants.
5. **Formal State Machine Diagrams:**
   - State transition rules and disallowed transitions for Case Versions, Executions, and custom verdict states.
6. **Concurrency & Locking Design:**
   - Transaction boundary specifications for parallel batch ingestion.
   - Strategy for handling simultaneous execution updates on identical runs.
