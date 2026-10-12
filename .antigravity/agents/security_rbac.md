# Role: Security & RBAC Analyst

> **Note (2026-10-11):** this is the brief given to a planning agent in September 2026. It records what was asked for, not what was built. Where the build differs, see RFC 04 for the code as it is, and `CLAUDE.md`.


## Mission
Design a hardened, granular Role-Based Access Control (RBAC) model, token lifecycle architecture, and tamper-resistant audit subsystem for an enterprise TestLink alternative. The platform must transition from TestLink's notoriously loose and brittle permission system into a modern, least-privilege security model that seamlessly supports both local self-hosted setups and compliance-driven enterprise deployments.

## Security Architecture & Access Standards

### 1. Granular Permission Key Registry
Enforce explicit, string-constant permission keys scoped across administrative, authoring, and execution operations:
- **System & Workspace:** `SYSTEM_ADMIN`, `PROJECT_CREATE`, `PROJECT_DELETE`, `USER_MANAGE`
- **Specification Authoring:** `SPEC_VIEW`, `SPEC_CREATE`, `SPEC_EDIT`, `SPEC_APPROVE`, `SPEC_DELETE`
- **Execution & Planning:** `PLAN_MANAGE`, `RUN_MANAGE`, `EXECUTE_RUN`, `EXECUTE_OVERWRITE`
- **Integrations & Data:** `IMPORT_DATA`, `EXPORT_DATA`, `API_TOKEN_MANAGE`

### 2. Built-in Role Templates & Scoping Hierarchy
- **Standard Roles:**
  - `Admin`: Full system-wide or project-wide privileges.
  - `Test Lead`: Authoring, approving specifications, creating plans/builds, managing assignments.
  - `Tester / QA Engineer`: Read access to specs, permission to execute runs, record verdicts, and log notes.
  - `Automation Service`: Scoped strictly to ingest execution runs (`EXECUTE_RUN`) via CI/CD runners.
  - `Viewer / Stakeholder`: Read-only access to specs, plans, metrics, and audit logs.
- **Hierarchical Scoping:** Permissions can be assigned at the **Global** (system-wide) level or overridden at the **Project** level.

### 3. Authentication, API Tokens & CI/CD Scopes
- **User Sessions:** Short-lived JWTs (or secure session cookies) coupled with rotating refresh tokens stored in HTTP-only, secure cookies.
- **Machine API Tokens:** 
  - Token format: High-entropy prefixed strings (e.g., `tf_ci_...`).
  - Storage: Store only cryptographically salted hashes (e.g., SHA-256 or Argon2id) in the database; plaintext tokens are revealed strictly once upon creation.
  - Scoping & Expiry: Tokens must support explicit capability narrowing (e.g., restricted strictly to a single project and the `EXECUTE_RUN` action) and configurable TTL/expiry dates.

### 4. Immutable Audit Logs & Compliance Trail
- **Tamper Resistance:** All destructive, state-altering, or permission-granting actions (`test_case.deleted`, `version.approved`, `verdict.overwritten`, `role.assigned`) must emit append-only records into an `audit_logs` table.
- **Audit Payload Structure:**
  - `id` (UUIDv7)
  - `actor_id` (User ID or Token ID)
  - `actor_type` (`USER`, `SERVICE_ACCOUNT`)
  - `action` (e.g., `EXECUTION_OVERWRITE`)
  - `resource_type` (e.g., `test_case_version`)
  - `resource_id` (UUIDv7)
  - `diff` (JSON snapshot of `before` and `after` states)
  - `ip_address` & `user_agent`
  - `timestamp` (UTC ISO-8601)
- **Retention & Immutability:** Enforce database-level access restrictions preventing updates or deletes on audit entries.

---

## Required Output Deliverables
Produce `docs/rfc_04_rbac_security_matrix.md` containing:

1. **Complete RBAC Matrix:**
   - Detailed mapping matrix table: Roles vs. Permission Keys across Global and Project scopes.
   - Access control evaluation algorithm (how project-level overrides resolve against global roles).
2. **Token Lifecycle & CI/CD Security Protocol:**
   - Generation, storage, revocation, and rotation flows for API tokens.
   - Header validation pattern for automated runners hitting `/executions/batch`.
3. **Audit Logging Specification:**
   - Schema definition for the `audit_logs` table.
   - Comprehensive event catalog listing all trigger events, tracked fields, and state diff schemas.
4. **Threat Model & Mitigation Controls:**
   - Analysis of common QA platform risks: unauthorized test case tampering, automated execution spoofing, mass data exfiltration via export endpoints, and rate-limiting enforcement.
