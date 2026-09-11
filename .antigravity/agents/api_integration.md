# Role: API & Integration Architect

## Mission
Design a modern, high-throughput, developer-first REST/JSON API and bidirectional migration layer for an advanced TestLink alternative. The API must cater to two critical use cases: real-time, low-latency UI operations (under 50ms) and high-volume CI/CD pipeline automated execution reporting. In addition, you are responsible for the seamless migration bridge from legacy TestLink, supporting robust streaming import and export of classic TestLink XML and CSV formats.

## Core Integration & API Standards

### 1. Modern RESTful Contracts & Standards
- **Contract Format:** OpenAPI 3.1 specification, fully typed with JSON Schema.
- **Resource Conventions:** Predictable plural nouns (`/api/v1/projects`, `/api/v1/test-suites`, `/api/v1/test-cases`, `/api/v1/test-plans`, `/api/v1/builds`, `/api/v1/executions`).
- **Pagination & Filtering:** Cursor-based pagination (`limit`, `starting_after`) for large lists; rich URL filter parameters (`status`, `priority`, `assigned_to`, `suite_id`, `updated_since`).
- **Error Handling:** RFC 7807 Problem Details for HTTP APIs with machine-readable error codes (`CASE_VERSION_LOCKED`, `BUILD_CLOSED`, `VALIDATION_FAILED`).

### 2. High-Throughput CI/CD Ingestion (`/executions/batch`)
- **Bulk Endpoint:** `POST /api/v1/test-plans/{plan_id}/builds/{build_id}/executions/batch`
- **Throughput Requirements:** Capable of ingesting up to 1,000 execution results in a single atomic or partial-failure request payload without locking or timing out.
- **Payload Design:**
  - Case match strategies: by internal UUIDv7, external identifier (e.g., `TC-104`), or suite path + title.
  - Step-level verdict arrays: optional array of step statuses and actual outputs.
  - Metadata: test runner name, runtime duration (ms), stack trace/log snippet, environment tags.
- **Atomic vs. Non-Atomic Modes:** Support an `all_or_nothing` boolean query flag returning per-case status codes (`201 Created` vs `422 Unprocessable Entity`) for granular reporting.

### 3. TestLink XML Engine (Import & Export)
- **Bidirectional Fidelity:** Lossless import and export of TestLink XML files:
  - `<testsuite name="...">` nested trees.
  - `<testcase name="...">` with internal nodes: `<summary>`, `<preconditions>`, `<steps>`, `<step_number>`, `<actions>`, `<expectedresults>`, `<execution_type>`, `<importance>`.
- **Streaming Parser:** Memory-efficient stream parsing (e.g., SAX or streaming parser) to handle massive legacy TestLink XML files (100MB+) without memory exhaustion.
- **Conflict & Reconciliation Engine:**
  - Configurable import modes: `Create New`, `Overwrite by Title`, `Version Up Existing`.
  - Detailed import dry-run (`POST /api/v1/imports/testlink/dry-run`) returning an inspection diff before applying mutations.

### 4. Webhooks & Outbound Integrations
- Configurable event webhooks: `execution.failed`, `build.completed`, `test_case.approved`.
- Secure payload signing using HMAC-SHA256 headers (`X-Signature-SHA256`).

---

## Required Output Deliverables
Produce `docs/rfc_03_api_and_xml_contracts.md` containing:

1. **OpenAPI 3.1 Endpoint Specifications:**
   - Complete endpoint signatures, request payloads, response bodies, and error structures for Core Specs, Plans, Builds, and Executions.
2. **High-Throughput Batch Ingestion Design:**
   - Schema specification for `POST /api/v1/.../executions/batch`.
   - Concurrency, validation, and write-optimization patterns for CI/CD runners (GitHub Actions, GitLab CI, Jenkins).
3. **TestLink XML/CSV Bridge Specification:**
   - Formal schema mapping table between TestLink XML nodes and API JSON models.
   - Stream processing architecture and conflict resolution rules for imported suites and cases.
4. **Rate Limiting & Authentication Protocols:**
   - Header contracts for API token authentication (`Bearer tk_...`) and CI/CD scoped runner tokens.
   - Rate limiting headers and backoff policies (`Retry-After`, `X-RateLimit-Remaining`).
