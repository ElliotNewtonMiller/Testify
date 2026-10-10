# RFC 03: API Contracts, High-Throughput Ingestion & Multi-Format Migration Engine

**Document Status:** Approved & Locked  
**Date:** September 8, 2026  
**Author:** API & Integration Architecture Team  
**Target Platform:** Testify / Next-Gen Test Management  
**Related Documents:** [docs/00_requirements_alignment.md](file:///docs/00_requirements_alignment.md), [docs/rfc_01_domain_model.md](file:///docs/rfc_01_domain_model.md)

---

## 1. Architectural Principles & RESTful API Standards

The Testify API layer is built to solve two contrasting operational demands:
1. **Real-Time Interactive UI:** Low-latency operations (< 50ms p95 response time) for browsing suite hierarchies, editing test cases, and toggling execution verdicts in the web application.
2. **High-Throughput CI/CD Pipeline Ingestion:** Bulk result streaming capable of processing 1,000+ execution results per request from automated test runners (GitHub Actions, GitLab CI, Jenkins, Playwright, PyTest) without table locking or HTTP timeouts.

```
+-----------------------------------------------------------------------------------+
|                                 API Client Layer                                  |
|  +------------------------------+             +--------------------------------+  |
|  | Modern Single-Page App (UI)  |             | Automated CI/CD Test Runners   |  |
|  +--------------+---------------+             +---------------+----------------+  |
+-----------------|---------------------------------------------|-------------------+
                  | (Low-Latency RESTful JSON)                  | (High-Throughput Batch POST)
                  v                                             v
+-----------------------------------------------------------------------------------+
|                             Testify API Gateway                                   |
|  +-----------------------------------------------------------------------------+  |
|  | Authentication (Bearer tk_...) & Rate Limiter (Token Bucket Engine)         |  |
|  +-----------------------------------------------------------------------------+  |
|  | OpenAPI 3.1 Router & RFC 7807 Problem Details Error Handler                 |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------|---------------------------------------------|-------------------+
                  v                                             v
+------------------------------------+        +-------------------------------------+
| Domain Controllers & Spec Service  |        | Bulk Batch Execution Processor      |
| (Projects, Suites, Cases, Plans)   |        | (Stream Mapper, In-Memory Lookup)   |
+-----------------+------------------+        +-----------------+-------------------+
                  |                                             |
                  +----------------------+----------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                        Dual Database Engine (SQLite / Postgres)                   |
|  +-----------------------------------------------------------------------------+  |
|  | Atomic Batch Transactions / UUIDv7 Foreign Keys / Immutable Execution Logs  |  |
|  +-----------------------------------------------------------------------------+  |
+----------------------------------------+------------------------------------------+
                                         | (Out-of-band attachments & raw logs)
                                         v
+-----------------------------------------------------------------------------------+
|                      IStorageProvider (Local File System / AWS S3)                |
+-----------------------------------------------------------------------------------+
```

### 1.1 Specification & Resource Conventions
- **Contract Standard:** Native **OpenAPI 3.1.0** specification, fully typed with JSON Schema (Draft 2020-12). All endpoints strictly enforce `application/json` content types unless streaming raw binary attachments.
- **URI Naming:** Predictable plural nouns with hierarchical nesting for sub-resources:
  - Base Path: `/api/v1`
  - Specification Entities: `/projects`, `/test-suites`, `/test-cases`, `/test-case-versions`
  - Execution Entities: `/test-plans`, `/builds`, `/executions`
  - Migration & Ingestion: `/imports/dry-run`, `/imports/execute`, `/exports/testlink`

### 1.2 Cursor-Based Pagination & Filtering
To guarantee sub-50ms query response times over millions of records, all list endpoints mandate cursor-based pagination using monotonic **UUIDv7** primary keys.

- **Query Parameters:**
  - `limit` (integer, optional): Items per page. Default `50`, maximum `250`.
  - `starting_after` (string, optional): UUIDv7 cursor cursor indicating the last item from the previous page.
  - `direction` (string, optional): `next` (default) or `prev`.
- **Filtering Parameters:**
  - `status` (string/array): Filter by execution or case version status (e.g., `PASSED,FAILED` or `APPROVED`).
  - `priority` (string/array): Filter by importance (`HIGH`, `MEDIUM`, `LOW`).
  - `assigned_to` (string): User UUIDv7 assigned to the test plan case.
  - `suite_id` (string): Filter by test suite tree node.
  - `updated_since` (string): ISO 8601 timestamp for incremental sync.
- **Pagination Header Standards:**
  - `X-Has-More`: Boolean indicating if subsequent pages exist.
  - `X-Next-Cursor`: UUIDv7 string of the final item in the payload.
  - `X-Total-Count`: Integer representing total matching records (calculated asynchronously for large datasets).

---

## 2. OpenAPI 3.1 Endpoint Specifications

### 2.1 Test Specification Core API (`/projects`, `/test-suites`, `/test-cases`)

#### `GET /api/v1/projects/{project_id}/test-suites`
Retrieves the hierarchical test suite tree for a given project.
- **Query Parameters:** `parent_id` (optional, default null for root suites), `include_cases` (boolean).
- **Response (200 OK):**
```json
{
  "object": "list",
  "data": [
    {
      "id": "0191c4d0-7a1a-7b3c-8e4d-1a2b3c4d5e6f",
      "project_id": "0191c4d0-0000-7000-8000-000000000001",
      "parent_id": null,
      "name": "Authentication & Authorization",
      "details": "End-to-end security and login test suites",
      "node_order": 1,
      "created_at": "2026-09-08T10:00:00Z",
      "updated_at": "2026-09-08T10:00:00Z"
    }
  ],
  "has_more": false
}
```

#### `POST /api/v1/test-suites/{suite_id}/test-cases`
Creates a new test case specification and generates its initial `v1` draft version.
- **Request Body:**
```json
{
  "title": "Verify OAuth2 Refresh Token Rotation",
  "external_id": "TC-Auth-102",
  "priority": "HIGH",
  "importance": "HIGH",
  "execution_type": "AUTOMATED",
  "summary": "Ensure that old refresh tokens are invalidated upon issuing a new pair.",
  "preconditions": "User has an active session and valid refresh token.",
  "steps": [
    {
      "step_number": 1,
      "actions": "POST /api/v1/auth/refresh with token R1",
      "expected_results": "Returns HTTP 200 with new token pair (A2, R2)",
      "execution_type": "AUTOMATED"
    },
    {
      "step_number": 2,
      "actions": "POST /api/v1/auth/refresh with token R1 again",
      "expected_results": "Returns HTTP 401 and revokes token family R2",
      "execution_type": "AUTOMATED"
    }
  ],
  "custom_fields": {
    "cf_automation_framework": "Playwright",
    "cf_security_tier": "Tier-1"
  }
}
```
- **Response (201 Created):**
```json
{
  "id": "0191c4d0-8b2b-7c4d-9f5e-2b3c4d5e6f7a",
  "suite_id": "0191c4d0-7a1a-7b3c-8e4d-1a2b3c4d5e6f",
  "external_id": "TC-Auth-102",
  "current_version_number": 1,
  "status": "DRAFT",
  "title": "Verify OAuth2 Refresh Token Rotation",
  "importance": "HIGH",
  "steps_count": 2,
  "created_at": "2026-09-08T12:00:00Z"
}
```

---

### 2.2 Test Plan & Build Management API (`/test-plans`, `/builds`)

#### `POST /api/v1/projects/{project_id}/test-plans`
Creates a new Test Plan container.
- **Request Body:**
```json
{
  "name": "Sprint 42 Regression Suite",
  "notes": "Scope covers Core API and Payment Integration",
  "is_active": true
}
```
- **Response (201 Created):** Returns the `TestPlan` object with state `ACTIVE`.

#### `PUT /api/v1/test-plans/{plan_id}/status`
Transitions a Test Plan between `ACTIVE`, `LOCKED`, and `ARCHIVED`.
- **Request Body:**
```json
{
  "status": "LOCKED",
  "reason": "Release v2.4.0 code freeze enforced."
}
```

#### `POST /api/v1/test-plans/{plan_id}/builds`
Creates a Build entry under an active Test Plan.
- **Request Body:**
```json
{
  "name": "v2.4.0-rc3",
  "notes": "CI Build #981247",
  "is_open": true,
  "release_date": "2026-09-10"
}
```

---

## 3. High-Throughput CI/CD Ingestion Engine (`POST /executions/batch`)

Modern automated test execution streams hundreds to thousands of test results in continuous integration pipelines. To support pipeline execution without causing connection pool exhaustion or lock contention, Testify implements a specialized bulk ingestion endpoint.

### 3.1 Bulk Endpoint Schema Specification

`POST /api/v1/test-plans/{plan_id}/builds/{build_id}/executions/batch`

#### Query Parameters:
- `all_or_nothing` (boolean, optional, default `false`): Controls transaction boundary.
  - `true`: Atomic mode. If any single result validation or case lookup fails, the entire batch is rejected with `HTTP 422 Unprocessable Entity` and no records are saved.
  - `false`: Partial failure mode. Valid results are written, and invalid entries are returned in an error summary payload with `HTTP 207 Multi-Status`.

#### Request Payload (`application/json`):
```json
{
  "environment": "staging-us-east-1",
  "runner_info": {
    "name": "GitHub Actions",
    "run_id": "98124712",
    "job_name": "e2e-regression / chrome-suite",
    "commit_sha": "a1b2c3d4e5f67890123456789abcdef012345678"
  },
  "executions": [
    {
      "case_identifier": {
        "external_id": "TC-Auth-102"
      },
      "verdict": "PASSED",
      "status": "COMPLETED",
      "duration_ms": 3420,
      "executed_at": "2026-09-08T13:15:00Z",
      "notes": "Test executed successfully in Chrome 128 headless.",
      "environment_tags": {
        "browser": "chrome-128",
        "os": "ubuntu-24.04"
      },
      "step_results": [
        {
          "step_number": 1,
          "verdict": "PASSED",
          "actual_result": "HTTP 200 returned with valid tokens."
        },
        {
          "step_number": 2,
          "verdict": "PASSED",
          "actual_result": "HTTP 401 returned and token family revoked."
        }
      ]
    },
    {
      "case_identifier": {
        "by_path_title": {
          "suite_path": "Payments / Checkout Gateway",
          "title": "Verify Stripe 3DS Challenge Flow"
        }
      },
      "verdict": "FAILED",
      "status": "COMPLETED",
      "duration_ms": 12450,
      "executed_at": "2026-09-08T13:15:05Z",
      "stack_trace": "TimeoutError: element ('#stripe-3ds-iframe') not visible after 10000ms\n    at Page.waitForSelector (/tests/checkout.spec.ts:45:12)",
      "notes": "Failed during 3DS challenge frame load.",
      "step_results": [
        {
          "step_number": 1,
          "verdict": "PASSED",
          "actual_result": "Cart initialized."
        },
        {
          "step_number": 2,
          "verdict": "FAILED",
          "actual_result": "Iframe failed to mount within timeout."
        }
      ]
    },
    {
      "case_identifier": {
        "by_uuid": "0191c4d0-8b2b-7c4d-9f5e-2b3c4d5e6f7a"
      },
      "verdict": "SKIPPED",
      "status": "COMPLETED",
      "duration_ms": 0,
      "executed_at": "2026-09-08T13:15:06Z",
      "notes": "Skipped due to dependency flag --disable-payment-tests"
    }
  ]
}
```

#### Response Payload (`207 Multi-Status` / `201 Created`):
```json
{
  "object": "batch_execution_result",
  "summary": {
    "total_submitted": 3,
    "successful": 3,
    "failed": 0,
    "duration_ms": 42
  },
  "results": [
    {
      "index": 0,
      "status": 201,
      "execution_id": "0191c4d5-1111-7000-8000-000000000001",
      "case_id": "0191c4d0-8b2b-7c4d-9f5e-2b3c4d5e6f7a",
      "verdict": "PASSED"
    },
    {
      "index": 1,
      "status": 201,
      "execution_id": "0191c4d5-2222-7000-8000-000000000002",
      "case_id": "0191c4d0-9c3c-7d5e-0f6f-3c4d5e6f7a8b",
      "verdict": "FAILED"
    },
    {
      "index": 2,
      "status": 201,
      "execution_id": "0191c4d5-3333-7000-8000-000000000003",
      "case_id": "0191c4d0-8b2b-7c4d-9f5e-2b3c4d5e6f7a",
      "verdict": "SKIPPED"
    }
  ]
}
```

---

### 3.2 Ingestion Concurrency & Write Optimization Patterns

To guarantee processing under **50ms for 1,000 items**, the batch ingestion pipeline relies on four key execution patterns:

1. **Pre-Fetched Key Resolution Cache:**
   - Instead of running N separate SQL queries to resolve `external_id`, `by_uuid`, or `suite_path + title`, the server performs a single batch lookup against the locked `test_plan_cases` mapping for `{plan_id}`.
   - An in-memory map converts incoming identifiers to locked `test_case_version_id` primary keys in $$O(1)$$ time.
2. **Bulk SQL Batch Insertion:**
   - Single transactional `INSERT INTO executions` statement constructing multi-row SQL insert tuples (or `COPY` command in PostgreSQL mode).
   - Prevents round-trip network latencies and avoids holding database table locks.
3. **Asynchronous Log Offloading:**
   - Full stack traces and test logs exceeding 4KB are immediately stripped from the synchronous database write payload and written asynchronously to the `IStorageProvider` out-of-band layer.
4. **Execution Snapshot Binding:**
   - Executions bind to the **frozen `test_case_version_id` snapshot** that was assigned to the `test_plan` at the moment of plan lock/creation. Changes to the underlying draft test case do not impact historical ingestion.

---

## 4. Locked Plan & Closed Build HTTP 422 Standards

Per the locked system constraints in [docs/00_requirements_alignment.md](file:///docs/00_requirements_alignment.md), completed execution results remain permanently viewable and exportable for audit compliance. However, **any operational attempt to create, update, or overwrite execution results against a locked Test Plan or closed Build must be strictly blocked and rejected with HTTP 422 Unprocessable Entity**.

### 4.1 RFC 7807 Error Specification
All operational error responses conform strictly to **RFC 7807 Problem Details for HTTP APIs**.

#### Error Response: Execution Submission to Closed Build
```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json

{
  "type": "https://api.testify.dev/errors/BUILD_CLOSED",
  "title": "Unprocessable Entity",
  "status": 422,
  "code": "BUILD_CLOSED",
  "detail": "Build 'v2.4.0-rc1' (ID: 0191c4d0-9a9a-7000-8000-000000000099) is closed. Executions cannot be added or modified on a closed build.",
  "instance": "/api/v1/test-plans/0191c4d0-1111-7000-8000-000000000005/builds/0191c4d0-9a9a-7000-8000-000000000099/executions/batch",
  "invalid_params": [
    {
      "name": "build_id",
      "reason": "Build status is CLOSED"
    }
  ],
  "timestamp": "2026-09-08T13:20:00Z"
}
```

#### Error Response: Execution Submission to Locked Test Plan
```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json

{
  "type": "https://api.testify.dev/errors/PLAN_LOCKED",
  "title": "Unprocessable Entity",
  "status": 422,
  "code": "PLAN_LOCKED",
  "detail": "Test Plan 'Sprint 41 Final' (ID: 0191c4d0-1111-7000-8000-000000000005) is locked. Plan specifications and execution states are frozen.",
  "instance": "/api/v1/test-plans/0191c4d0-1111-7000-8000-000000000005/builds/0191c4d0-9a9a-7000-8000-000000000099/executions",
  "timestamp": "2026-09-08T13:21:00Z"
}
```

### 4.2 Error Code Registry
| Error Code | HTTP Status | Trigger Condition | Remediation / Resolution |
| :--- | :--- | :--- | :--- |
| `BUILD_CLOSED` | `422` | Attempting to `POST` or `PUT` execution results against a `Closed` build. | Admin must re-open build or target an open build. |
| `PLAN_LOCKED` | `422` | Attempting execution mutation or case assignment on a `Locked` or `Archived` Test Plan. | Admin must transition plan status back to `ACTIVE`. |
| `CASE_VERSION_LOCKED` | `422` | Attempting to modify an `Approved` or frozen `TestCaseVersion`. | User must spawn a new `Draft` version (`v2`). |
| `DRAFT_VERSION_ASSIGNMENT_DISALLOWED` | `422` | Adding a `Draft` test case to a Test Plan when project setting `allow_draft_testing = false`. | Case version must be transitioned to `APPROVED`. |
| `VALIDATION_FAILED` | `422` | JSON Schema validation failure on request payload. | Fix schema violations detailed in `invalid_params`. |

---

## 5. Out-of-Band Log Snippet & Attachment Storage Architecture

Storing massive stack traces, terminal logs, and execution screenshots inside relational database tables (PostgreSQL/SQLite) causes index fragmentation, table bloat, and severe performance degradation.

### 5.1 Storage Policy & Retention Rules
- **Execution History Purge:**
  - Default retention threshold: **365 days (1 year)**.
  - Purge threshold is **admin-modifiable** per environment or project.
  - Background cron job purges execution records and associated out-of-band attachments older than the configured threshold.
- **Audit Log Retention:**
  - The `audit_logs` relational table is stored in the primary database with **no automatic deletion**.
  - Append-only forever for regulatory compliance, subject to manual administrative CLI maintenance only.
- **Out-of-Band Storage Rule:**
  - Log snippets larger than 4KB and all binary attachments (screenshots, videos, trace files) are stored exclusively in out-of-band storage via `IStorageProvider`.
  - Relational database tables hold only a lightweight URI reference (`storage_key`), checksum (SHA-256), byte size, and MIME type.

---

### 5.2 Storage Abstraction Driver (`IStorageProvider`)

```typescript
export interface StorageObjectMetadata {
  key: string;
  contentType: string;
  sizeBytes: number;
  sha256Checksum: string;
  createdAt: Date;
}

export interface IStorageProvider {
  /**
   * Uploads a data stream to the out-of-band storage layer.
   */
  putObject(
    key: string,
    content: ReadableStream | Buffer,
    metadata: { contentType: string; project_id: string }
  ): Promise<StorageObjectMetadata>;

  /**
   * Retrieves a read stream for a stored object.
   */
  getObject(key: string): Promise<ReadableStream>;

  /**
   * Deletes an object from storage during retention purge.
   */
  deleteObject(key: string): Promise<void>;

  /**
   * Generates a pre-signed URL for direct client upload or download.
   */
  getPresignedUrl(
    key: string,
    operation: 'READ' | 'WRITE',
    expiresInSeconds: number
  ): Promise<string>;
}
```

#### Dual Driver Implementations:
1. **`LocalStorageProvider` (Dev / SQLite Mode):**
   - Stores files directly on the local filesystem relative to the app data directory: `./data/attachments/{project_id}/{year}/{month}/{uuidv7}.bin`.
   - Streaming HTTP routes stream files directly from disk without reading entire payloads into Node.js/Go process memory.
2. **`S3StorageProvider` (Production / PostgreSQL Mode):**
   - Integrates with AWS S3, MinIO, Cloudflare R2, or Google Cloud Storage using S3-compatible APIs.
   - High-volume binary uploads bypass the API gateway completely using **S3 Pre-Signed Upload URLs**.

---

### 5.3 Attachment Endpoints & Direct S3 Pre-Signed Protocol

```
+---------------+              +--------------------+              +--------------------+
|  CI Runner /  |              | Testify            |              | AWS S3 / MinIO     |
| Client App    |              | API Gateway        |              | Storage Bucket     |
+-------+-------+              +---------+----------+              +---------+----------+
        |                                |                                   |
        | 1. POST /attachments/presign   |                                   |
        |------------------------------->|                                   |
        |                                | 2. Generate S3 PutObject URL      |
        |                                |---------------------------------->|
        | 3. Returns presigned_url + key |                                   |
        |<-------------------------------|                                   |
        |                                                                    |
        | 4. PUT binary file directly to presigned_url                       |
        |------------------------------------------------------------------->|
        | 5. HTTP 200 OK (Uploaded to S3 bucket)                             |
        |<-------------------------------------------------------------------|
        |                                |                                   |
        | 6. POST /executions/{id}/attach (Register key + SHA256)            |
        |------------------------------->|                                   |
        | 7. HTTP 201 Created            |                                   |
        |<-------------------------------|                                   |
```

#### `POST /api/v1/executions/{execution_id}/attachments/presign`
- **Request Body:**
```json
{
  "filename": "failure_screenshot.png",
  "content_type": "image/png",
  "size_bytes": 245812
}
```
- **Response (200 OK):**
```json
{
  "storage_key": "att/proj-01/2026/09/0191c4d8-4444-7000-8000-000000000099.png",
  "upload_url": "https://testify-bucket.s3.us-east-1.amazonaws.com/att/proj-01/2026/09/0191c4d8-4444-7000-8000-000000000099.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",
  "expires_at": "2026-09-08T13:30:00Z"
}
```

---

## 6. Extensible Multi-Format Ingestion & Migration Engine

Migrating legacy test repositories into Testify requires supporting legacy **TestLink XML**, native **JSON**, and enterprise **CSV** format spec sheets while handling schema differences, missing custom fields, and duplicate suite titles.

```
+-----------------------------------------------------------------------------------+
|                        Multi-Format Ingestion Engine                              |
|  +-----------------------+ +-----------------------+ +-------------------------+  |
|  | Legacy TestLink XML   | | Testify JSON          | | Standard Tabular CSV    |  |
|  | (<testsuite>/<steps>) | | Schema Spec Sheet     | | Spec Sheets             |  |
|  +-----------+-----------+ +-----------+-----------+ +------------+------------+  |
+--------------|-------------------------|--------------------------|---------------+
               v                         v                          v
+-----------------------------------------------------------------------------------+
|                    Extensible Stream Parser Architecture                          |
|  +-----------------------------------------------------------------------------+  |
|  | SAX XML Stream Parser / JSON Stream Parser / CSV Chunked Stream Parser       |  |
|  +-----------------------------------------------------------------------------+  |
+----------------------------------------+------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|               Phase 1: Dry-Run Inspection Diff & Setup Modals                     |
|  +-----------------------------------------------------------------------------+  |
|  | 1. Custom Field Pre-Import Setup Modal (Drop / Auto-Create / Route Existing) |  |
|  | 2. Duplicate Reconciliation Modal (Create / Overwrite / Version Up / Skip)  |  |
|  +-----------------------------------------------------------------------------+  |
+----------------------------------------+------------------------------------------+
                                         | (Validated Execution Plan)
                                         v
+-----------------------------------------------------------------------------------+
|               Phase 2: Atomic Execution & Database Write Engine                   |
+-----------------------------------------------------------------------------------+
```

### 6.1 Extensible Parser Plugin Architecture
The ingestion engine defines a strict parser interface (`IFileParser`). New formats can be registered cleanly without modifying core import pipelines.

```typescript
export interface ParsedStep {
  step_number: number;
  actions: string;
  expected_results: string;
  execution_type: 'MANUAL' | 'AUTOMATED';
}

export interface ParsedCase {
  external_id?: string;
  title: string;
  summary?: string;
  preconditions?: string;
  importance: 'HIGH' | 'MEDIUM' | 'LOW';
  execution_type: 'MANUAL' | 'AUTOMATED';
  steps: ParsedStep[];
  custom_fields: Record<string, string>;
}

export interface ParsedSuite {
  name: string;
  details?: string;
  node_order: number;
  sub_suites: ParsedSuite[];
  test_cases: ParsedCase[];
}

export interface IFileParser {
  formatId: 'TESTLINK_XML' | 'NATIVE_JSON' | 'STANDARD_CSV';
  canHandle(fileHeader: Buffer, filename: string): boolean;
  parseStream(
    inputStream: ReadableStream,
    options: { defaultImportance?: string }
  ): AsyncIterable<ParsedSuite>;
}
```

---

### 6.2 Schema Mapping Specifications

#### TestLink XML Node to Domain Model Mapping Table

| Legacy TestLink XML Element | Target API / DB Entity Field | Type Transformation & Rules |
| :--- | :--- | :--- |
| `<testsuite name="...">` | `TestSuite.name` | Strips leading/trailing whitespace. Preserves parent-child nesting. |
| `<details>` | `TestSuite.details` | HTML-decoded string converted to clean Markdown. |
| `<testcase name="...">` | `TestCase.title` | Mapped to title. Truncated if over 255 chars with warning. |
| `<externalid>` | `TestCase.external_id` | Mapped directly (e.g. `TC-104`). Uniqueness enforced per project. |
| `<summary>` | `TestCaseVersion.summary` | Sanitized HTML converted to Markdown format. |
| `<preconditions>` | `TestCaseVersion.preconditions` | Markdown text blob. |
| `<importance>` | `TestCaseVersion.importance` | XML `1` -> `LOW`, `2` -> `MEDIUM`, `3` -> `HIGH`. |
| `<execution_type>` | `TestCaseVersion.execution_type` | XML `1` -> `MANUAL`, `2` -> `AUTOMATED`. |
| `<steps><step>` | `TestStep` array | Iterated in `<step_number>` order. |
| `<step_number>` | `TestStep.step_number` | 1-indexed integer. |
| `<actions>` | `TestStep.actions` | Cleaned text/markdown. |
| `<expectedresults>` | `TestStep.expected_results` | Cleaned text/markdown. |
| `<custom_fields><custom_field>` | `TestCaseVersion.custom_fields` | `<name>` mapped to key, `<value>` mapped to value string. |

#### Native JSON & CSV Mapping Policies:
- **Native JSON (`.json`):** Validated against `testify-suite.schema.json`. Directly mirrors domain models without loss.
- **Standard CSV (`.csv`):** Configurable column headers: `Suite Path`, `Title`, `External ID`, `Summary`, `Preconditions`, `Step Number`, `Step Action`, `Step Expected Result`, `Importance`, `Execution Type`, plus arbitrary custom field columns (`CF: Automation ID`).

---

### 6.3 Large File Streaming Parser Architecture (100MB+)

Legacy TestLink exports can exceed 100MB and contain over 50,000 test cases. Loading full XML DOM trees into memory causes Node.js heap exhaustion (`ERR_STRING_TOO_LONG` / `JS allocation failed`).

- **XML Streaming Implementation:** Uses a SAX-based event-driven parser (`sax-js` / `expat`). As the parser emits `<testsuite>` and `<testcase>` tag tokens, entities are transformed into lightweight JSON records and pushed to a chunked pipeline stream.
- **Memory Footprint:** Peak memory usage is bounded to **< 64MB** regardless of XML file size.
- **Progress Streaming:** Background import jobs stream real-time progress events over WebSocket / SSE (`bytes_processed`, `cases_parsed`, `percentage_complete`).

---

### 6.4 Pre-Import Setup Modals & Reconciliation Engine

Prior to executing mutations against the database, the import pipeline analyzes the parsed stream and prompts the user through two mandatory configuration steps:

#### 1. Custom Field Pre-Import Setup Modal
When the incoming import file contains custom fields not yet registered in the target project, the UI displays the Custom Field Reconciliation modal.

```json
{
  "unmapped_custom_fields": [
    {
      "incoming_key": "cf_jira_key",
      "sample_value": "PROJ-1234",
      "detected_type": "STRING"
    },
    {
      "incoming_key": "cf_automation_tool",
      "sample_value": "Cypress",
      "detected_type": "SINGLE_SELECT"
    }
  ]
}
```

The user configures an explicit resolution strategy per field:
- `DROP`: Ignore incoming field and discard values.
- `AUTO_CREATE`: Automatically register a new `CustomFieldDefinition` in the project.
- `ROUTE_TO_EXISTING`: Map incoming key to an existing project custom field UUIDv7.

```json
{
  "field_mappings": [
    {
      "incoming_key": "cf_jira_key",
      "action": "ROUTE_TO_EXISTING",
      "target_field_id": "0191c4d0-5555-7000-8000-000000000012"
    },
    {
      "incoming_key": "cf_automation_tool",
      "action": "AUTO_CREATE",
      "field_name": "Automation Tooling",
      "field_type": "SINGLE_SELECT"
    }
  ]
}
```

#### 2. Duplicate Title Reconciliation Modal
When duplicate test suite or case titles are detected between the import payload and existing project specifications, the importer prompts the user with reconciliation options:

- **Supported Duplicate Actions:**
  - `CREATE_NEW`: Create a duplicate entity with suffix `(Copy)`.
  - `OVERWRITE`: Replace summary, preconditions, and steps on existing case version.
  - `VERSION_UP`: Increment existing case version (`v1` -> `v2`), preserving historical runs.
  - `SKIP`: Omit incoming duplicate case from import.
- **Session Scope Toggle:**
  - `"apply_to_all_future_duplicates": true`: Instructs the engine to remember the selected decision for all remaining matching duplicates in the session without displaying further prompts.

```json
{
  "duplicate_resolution": {
    "default_action": "VERSION_UP",
    "apply_to_all_future_duplicates": true,
    "overrides": [
      {
        "external_id": "TC-Auth-102",
        "action": "OVERWRITE"
      }
    ]
  }
}
```

---

### 6.5 Mandatory Dry-Run Inspection Diff Endpoint

`POST /api/v1/imports/dry-run`

Reads the import file stream, applies field mappings and duplicate rules in memory without committing database mutations, and returns a comprehensive inspection diff.

#### Request Body (`multipart/form-data`):
- `file`: Raw binary import file (`.xml`, `.json`, `.csv`).
- `format`: `TESTLINK_XML` | `NATIVE_JSON` | `STANDARD_CSV`.
- `target_project_id`: Target project UUIDv7.
- `configuration`: JSON string specifying field mappings and duplicate resolution settings.

#### Response Payload (`200 OK`):
```json
{
  "dry_run_summary": {
    "total_suites_detected": 14,
    "total_cases_detected": 420,
    "suites_to_create": 14,
    "cases_to_create": 380,
    "cases_to_version_up": 35,
    "cases_to_overwrite": 5,
    "cases_skipped": 0,
    "unmapped_custom_fields_count": 0,
    "validation_warnings_count": 2
  },
  "warnings": [
    {
      "line_or_node": "testcase[name='Verify Payment Payload']",
      "code": "TITLE_TRUNCATED",
      "message": "Title exceeds 255 characters; automatically trimmed."
    },
    {
      "line_or_node": "testcase[external_id='TC-PAY-99']",
      "code": "EMPTY_STEPS",
      "message": "Test case contains no steps."
    }
  ],
  "hierarchy_preview": [
    {
      "name": "Authentication",
      "action": "CREATE_NEW",
      "cases_count": 25,
      "children": []
    }
  ]
}
```

---

## 7. Webhooks, Rate Limiting & Security Protocols

### 7.1 Authentication Protocols
All API requests must present a valid Bearer token in the `Authorization` header:

`Authorization: Bearer tk_live_0191c4d08b2b7c4d9f5e2b3c4d5e6f7a`

#### Token Scopes & CI/CD Runner Tokens:
1. **Personal Access Tokens (`tk_live_...`):** Full access tied to user permissions.
2. **CI/CD Scoped Runner Tokens (`tk_runner_...`):** Restricted tokens generated specifically for automated test runners. Runner tokens can *only* invoke `POST /api/v1/test-plans/{id}/builds/{id}/executions/batch` and read test plan metadata. Attempts to call admin or spec creation endpoints return `HTTP 403 Forbidden`.

---

### 7.2 Rate Limiting Policies & Response Headers
Limits are generous on purpose -- CI runners, scripts and MCP agents make many more calls than people -- and exist to stop runaway loops and abuse. Each is a **token bucket** per caller: the whole allowance can be used at once, and it refills evenly over the window. The counts are kept in memory per server process (`apps/server/src/services/rateLimits.ts`).

- **Rate Limits:**
  - Every request made with a machine API token (REST, `/executions/batch`, `/mcp`): **1,200 requests per minute per token**. A batch request can carry up to 5,000 results.
  - Exports (`.../exports/definitions`, `.../exports/execution-results`): **120 per hour per user or token**.
  - Sending report emails (`.../report-emails` without `preview`, `.../report-schedules/:id/send-now`, `/admin/email-settings/test`): **60 per hour per user or token**.
- **HTTP 429 Too Many Requests Payload:**
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
Content-Type: application/problem+json

{
  "type": "https://api.testify.dev/errors/RATE_LIMITED",
  "title": "Too Many Requests",
  "status": 429,
  "code": "RATE_LIMITED",
  "detail": "Too many requests with this API token: the limit is 1200 per minute. Try again in 1 second.",
  "instance": "/api/v1/projects/.../plans"
}
```

---

### 7.3 Webhook Event Delivery & HMAC-SHA256 Signing Protocols
Testify pushes real-time event notifications to external webhooks (Slack, Jira, CI pipelines, custom microservices).

#### Supported Webhook Events:
- `execution.failed`: Triggered when an automated or manual test run reports a `FAILED` or `BLOCKED` verdict.
- `build.completed`: Triggered when an admin closes a Build.
- `test_case.approved`: Triggered when a draft test case version is approved.
- `import.completed`: Triggered when a background XML/CSV import job finishes.

#### Webhook Security & Payload Verification:
Every outbound HTTP POST payload contains security headers allowing receivers to verify authenticity and prevent replay attacks:

- `X-Signature-Timestamp`: UTC Unix timestamp of event dispatch.
- `X-Signature-SHA256`: HMAC-SHA256 signature calculated over `${timestamp}.${raw_json_body}` using the webhook secret key (`whsec_...`).

#### Outbound Webhook Request Example:
```http
POST /hooks/testify-notifications HTTP/1.1
Host: ci-bridge.company.com
Content-Type: application/json
X-Signature-Timestamp: 1757365166
X-Signature-SHA256: 7f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a

{
  "id": "evt_0191c4d9-9999-7000-8000-000000000001",
  "event": "execution.failed",
  "timestamp": "2026-09-08T13:25:00Z",
  "data": {
    "project_id": "0191c4d0-0000-7000-8000-000000000001",
    "test_plan_id": "0191c4d0-1111-7000-8000-000000000005",
    "build_id": "0191c4d0-9a9a-7000-8000-000000000099",
    "case_id": "0191c4d0-9c3c-7d5e-0f6f-3c4d5e6f7a8b",
    "case_title": "Verify Stripe 3DS Challenge Flow",
    "verdict": "FAILED",
    "stack_trace": "TimeoutError: element ('#stripe-3ds-iframe') not visible after 10000ms"
  }
}
```

---

## 8. System Workflows & Architecture Diagrams

### 8.1 High-Throughput CI/CD Ingestion Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant CI as CI Runner (GitHub / Jenkins)
    participant GW as API Gateway & Auth
    participant Proc as Batch Ingestion Engine
    participant DB as DB (Postgres / SQLite)
    participant Storage as Out-of-Band Storage (S3 / FS)

    CI->>GW: POST /api/v1/test-plans/{p_id}/builds/{b_id}/executions/batch (Bearer tk_runner_...)
    GW->>GW: Authenticate Token & Check Token Bucket Rate Limits
    alt Build Closed or Plan Locked
        GW-->>CI: HTTP 422 Unprocessable Entity (BUILD_CLOSED / PLAN_LOCKED)
    else Build Open & Valid Token
        GW->>Proc: Dispatch Batch Payload (up to 1,000 executions)
        Proc->>DB: Batch Fetch Plan-Case Identifier Mappings (Single Query)
        Proc->>Proc: Resolve UUIDv7 Frozen Version IDs in Memory
        
        par Async Log Offloading
            Proc->>Storage: Stream Large Stack Traces / Attachments (>4KB)
            Storage-->>Proc: Return Storage Keys
        and Atomic SQL Write
            Proc->>DB: Single Transaction Bulk INSERT into `executions` & `execution_steps`
            DB-->>Proc: Commit Transaction Success
        end

        Proc-->>GW: Return Batch Processing Summary
        GW-->>CI: HTTP 207 Multi-Status / 201 Created JSON
    end
```

---

### 8.2 Multi-Format Streaming Import & Reconciliation Workflow

```mermaid
sequenceDiagram
    autonumber
    participant Client as User / Admin Web UI
    participant GW as API Gateway
    participant Stream as Streaming Ingestion Parser
    participant Recon as Reconciliation & Setup Engine
    participant DB as Primary Database

    Client->>GW: POST /api/v1/imports/dry-run (TestLink XML / CSV / JSON)
    GW->>Stream: Pipe File Read Stream (SAX / CSV Stream)
    Stream->>Recon: Stream Parsed Entities & Detect Custom Fields / Duplicates

    alt Unmapped Custom Fields Detected
        Recon-->>Client: Prompt Custom Field Pre-Import Setup Modal
        Client->>Recon: Submit Field Actions (Drop / Auto-Create / Route Existing)
    end

    alt Duplicate Titles Detected
        Recon-->>Client: Prompt Duplicate Title Reconciliation Modal
        Client->>Recon: Submit Resolution (Create Copy / Overwrite / Version Up / Skip)
    end

    Recon->>Recon: Compute Complete Mutation Diff in Memory
    Recon-->>Client: HTTP 200 OK (Dry-Run Diff Summary & Hierarchy Preview)

    Client->>GW: POST /api/v1/imports/execute (Confirmed Import Ticket ID)
    GW->>DB: Execute Atomic Database Batch Mutation
    DB-->>GW: Transaction Committed
    GW-->>Client: HTTP 200 OK (Import Complete - X Cases Created, Y Versioned Up)
```

---

## 9. Summary Compliance Matrix

| Requirement Area | Specification Standard | Conformance Reference |
| :--- | :--- | :--- |
| **OpenAPI 3.1 & REST** | Fully-typed JSON Schema endpoints with cursor-based UUIDv7 pagination | Section 1 & 2 |
| **High-Throughput Batch** | `POST /executions/batch` supporting 1,000 items under 50ms with `all_or_nothing` flag | Section 3 |
| **Operational Restrictions** | Closed builds & locked plans reject writes with HTTP 422 (`BUILD_CLOSED` / `PLAN_LOCKED`) | Section 4 |
| **Storage Abstraction** | Dual `IStorageProvider` (Local FS for Dev, AWS S3/MinIO for Prod). Purge at 365 days; Audit logs append-only forever | Section 5 |
| **Multi-Format Ingestion** | Extensible parser engine for TestLink XML, Native JSON, CSV with SAX streaming (< 64MB memory) | Section 6 |
| **Reconciliation Modals** | Pre-import custom field mapping & duplicate title reconciliation modals with session sticky toggle | Section 6.4 |
| **Dry-Run Inspection** | Mandatory `POST /imports/dry-run` inspection diff endpoint returning mutation preview | Section 6.5 |
| **Webhooks & Auth** | HMAC-SHA256 signed events (`X-Signature-SHA256`) & scoped CI/CD runner tokens | Section 7 |
