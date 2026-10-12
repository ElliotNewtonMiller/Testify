import React, { useState, useEffect } from "react";
import { authHeaders } from "../utils/session";

import { errorMessage as apiErrorMessage } from "../api/errors";
interface ProjectItem {
  id: string;
  name: string;
  prefix?: string;
}

type WizardStep = "UPLOAD" | "MAPPING" | "DUPLICATES" | "CONFIRM" | "RESULTS";

type FieldFormatId = "" | "TESTLINK_XML" | "NATIVE_JSON" | "STANDARD_CSV" | "JUNIT_XML" | "TESTRAIL_CSV";

type CustomFieldType = "TEXT" | "NUMBER" | "CHECKBOX" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT";

// A new SINGLE_SELECT/MULTI_SELECT field gets its options from the column's own values: one
// option per distinct value (multi-select splits comma-separated values first). The server
// computes them from the whole file at execute time; the wizard previews them below.
const CREATABLE_FIELD_TYPES: CustomFieldType[] = ["TEXT", "NUMBER", "CHECKBOX", "DATE", "SINGLE_SELECT", "MULTI_SELECT"];

/** Mirrors @testify/core's splitMultiSelectValue (the web app doesn't depend on core). */
function splitCommaValues(value: string): string[] {
  return Array.from(new Set(value.split(",").map((v) => v.trim()).filter(Boolean)));
}

/** The options a new select field would be created with, from the dry-run's distinct values. */
function previewSelectOptions(field: UnmappedCustomField, type: CustomFieldType): string[] {
  const values = field.distinct_values && field.distinct_values.length > 0 ? field.distinct_values : field.sample_values || [];
  if (type === "MULTI_SELECT") return Array.from(new Set(values.flatMap(splitCommaValues)));
  return values;
}

interface UnmappedCustomField {
  incoming_key: string;
  sample_value: string;
  sample_values?: string[];
  distinct_values?: string[];
  distinct_values_truncated?: boolean;
  detected_type: CustomFieldType;
}

interface DryRunResult {
  dry_run_summary: {
    total_suites_detected: number;
    total_cases_detected: number;
    suites_to_create: number;
    cases_to_create: number;
    cases_to_version_up: number;
    cases_to_overwrite: number;
    cases_skipped: number;
    unmapped_custom_fields_count: number;
    validation_warnings_count: number;
  };
  warnings: Array<{
    line_or_node: string;
    code: string;
    message: string;
    case_external_id?: string;
    case_title?: string;
    suite_path?: string;
  }>;
  unmapped_custom_fields: UnmappedCustomField[];
  hierarchy_preview: Array<{ name: string; action: string; cases_count: number; children: any[] }>;
}

interface FieldOption {
  id: string;
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  project_id: string | null;
}

type MappingAction = "DROP" | "AUTO_CREATE" | "ROUTE_TO_EXISTING";

interface FieldMappingChoice {
  action: MappingAction;
  target_field_id?: string;
  field_name?: string;
  field_type?: CustomFieldType;
}

type DuplicateAction = "CREATE_NEW" | "OVERWRITE" | "VERSION_UP" | "SKIP";

interface ImportExecuteResult {
  object: "import_execute_result";
  summary: {
    imported_suites_count: number;
    imported_cases_count: number;
    created_versions_count: number;
    overwritten_cases_count: number;
    skipped_cases_count: number;
    auto_created_custom_fields_count: number;
    skipped_custom_field_values_count: number;
    duration_ms: number;
  };
  skipped_custom_field_value_warnings?: Array<{ case_external_id_or_title: string; incoming_key: string; reason: string }>;
}

interface ImportWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectItem[];
  defaultProjectId?: string;
  onImportComplete?: () => void;
}

const FORMAT_OPTIONS: Array<{ value: FieldFormatId; label: string }> = [
  { value: "", label: "Auto-detect" },
  { value: "TESTLINK_XML", label: "TestLink XML" },
  { value: "NATIVE_JSON", label: "Native JSON" },
  { value: "STANDARD_CSV", label: "Standard CSV" },
  { value: "JUNIT_XML", label: "JUnit XML" },
  { value: "TESTRAIL_CSV", label: "TestRail CSV (always requires explicit selection)" },
];

const STEPS: Array<{ key: WizardStep; label: string }> = [
  { key: "UPLOAD", label: "1. Upload" },
  { key: "MAPPING", label: "2. Field Mapping" },
  { key: "DUPLICATES", label: "3. Duplicates" },
  { key: "CONFIRM", label: "4. Confirm" },
  { key: "RESULTS", label: "5. Results" },
];

/** Parses a JSON reply, or returns {} when the body is empty/not JSON (e.g. a proxy error or a
 * request the server dropped) -- so callers report the HTTP status instead of a raw
 * "Unexpected end of JSON input". */
async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Matches IMPORT_MAX_FILE_BYTES in apps/server/src/routes/ingestion.ts; checked here too so a
// too-large file is refused before it's uploaded.
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;

function describeFailedResponse(res: Response, fallback: string): string {
  if (res.status === 413) return "The file is too large to import (the limit is 50 MB).";
  if (res.status === 429) return "Other imports are running. Try again in a moment.";
  if (res.status >= 500) return `${fallback}: the server didn't return a usable response (HTTP ${res.status}).`;
  return `${fallback} (HTTP ${res.status}).`;
}

export function ImportWizardModal({ isOpen, onClose, projects, defaultProjectId, onImportComplete }: ImportWizardModalProps) {
  const [step, setStep] = useState<WizardStep>("UPLOAD");

  const [fileName, setFileName] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<FieldFormatId>("");
  const [targetProjectId, setTargetProjectId] = useState<string>("");

  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [fieldMappings, setFieldMappings] = useState<Record<string, FieldMappingChoice>>({});
  const [selectedUnmappedKey, setSelectedUnmappedKey] = useState<string | null>(null);
  const [duplicateAction, setDuplicateAction] = useState<DuplicateAction>("VERSION_UP");

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<ImportExecuteResult | null>(null);

  useEffect(() => {
    if (isOpen && !targetProjectId) {
      setTargetProjectId(defaultProjectId || projects[0]?.id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultProjectId, projects]);

  useEffect(() => {
    if (!isOpen) {
      resetWizard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (step === "MAPPING" && targetProjectId) {
      fetchFieldOptions(targetProjectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, targetProjectId]);


  const resetWizard = () => {
    setStep("UPLOAD");
    setFileName("");
    setFile(null);
    setFormat("");
    setDryRunResult(null);
    setFieldOptions([]);
    setFieldMappings({});
    setSelectedUnmappedKey(null);
    setDuplicateAction("VERSION_UP");
    setErrorMessage(null);
    setExecuteResult(null);
  };

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    if (!chosen) return;
    setErrorMessage(null);
    if (chosen.size > MAX_IMPORT_FILE_BYTES) {
      setFile(null);
      setFileName("");
      setErrorMessage(`${chosen.name} is too large to import (the limit is 50 MB).`);
      return;
    }
    setFileName(chosen.name);
    setFile(chosen);
  };

  // The file goes up as multipart/form-data, which the server reads as a stream -- not
  // base64 inside JSON, which was a third larger and had to be held whole to parse. The
  // browser keeps the File, so dry-run and execute just send it again.
  const buildImportForm = (): FormData => {
    const form = new FormData();
    if (format) form.append("format", format);
    form.append("target_project_id", targetProjectId);
    form.append(
      "configuration",
      JSON.stringify({
        field_mappings: Object.entries(fieldMappings).map(([incoming_key, choice]) => ({ incoming_key, ...choice })),
        duplicate_resolution: { default_action: duplicateAction },
      }),
    );
    if (file) form.append("file", file, fileName);
    return form;
  };

  const runDryRun = async (): Promise<DryRunResult | null> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/v1/imports/dry-run", {
        method: "POST",
        // No Content-Type: the browser sets multipart/form-data with its boundary.
        headers: authHeaders(),
        body: buildImportForm(),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        throw new Error(apiErrorMessage(data) || describeFailedResponse(res, "Failed to preview import"));
      }
      setDryRunResult(data);
      return data as DryRunResult;
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to preview import");
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const handleUploadNext = async () => {
    if (!file) {
      setErrorMessage("Choose a file first.");
      return;
    }
    if (!targetProjectId) {
      setErrorMessage("Choose a target project first.");
      return;
    }
    const result = await runDryRun();
    if (result) {
      setStep("MAPPING");
    }
  };

  const fetchFieldOptions = async (projectId: string) => {
    try {
      const res = await fetch(
        `/api/v1/imports/custom-field-options?target_project_id=${encodeURIComponent(projectId)}&entity_type=TestCase`,
        { headers: authHeaders() }
      );
      const data = await readJsonResponse(res);
      if (res.ok) {
        setFieldOptions(data.definitions || []);
      }
    } catch {
      // Ignore -- the "map to existing" dropdown just shows no options
    }
  };

  const setMappingFor = (incomingKey: string, choice: FieldMappingChoice) => {
    setFieldMappings((prev) => ({ ...prev, [incomingKey]: choice }));
  };

  const unresolvedCount = (dryRunResult?.unmapped_custom_fields || []).filter((f) => !fieldMappings[f.incoming_key]).length;

  const handleMappingNext = async () => {
    setErrorMessage(null);
    const result = await runDryRun();
    if (result) {
      setStep("DUPLICATES");
    }
  };

  const handleDuplicatesNext = async () => {
    setErrorMessage(null);
    const result = await runDryRun();
    if (result) {
      setStep("CONFIRM");
    }
  };

  const handleExecute = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/v1/imports/execute", {
        method: "POST",
        // No Content-Type: the browser sets multipart/form-data with its boundary.
        headers: authHeaders(),
        body: buildImportForm(),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        throw new Error(apiErrorMessage(data) || describeFailedResponse(res, "Import failed"));
      }
      setExecuteResult(data);
      setStep("RESULTS");
      onImportComplete?.();
    } catch (err: any) {
      setErrorMessage(err.message || "Import failed");
    } finally {
      setIsLoading(false);
    }
  };

  const selectedUnmapped = dryRunResult?.unmapped_custom_fields.find((f) => f.incoming_key === selectedUnmappedKey) || null;
  const selectedChoice = selectedUnmappedKey ? fieldMappings[selectedUnmappedKey] : undefined;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "840px",
          maxHeight: "85vh",
          backgroundColor: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: "10px",
          padding: "24px",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "20px" }}>📥 Import Test Suites &amp; Cases</h2>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px" }}>
              Upload a file, resolve any unmapped fields, and confirm before importing.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid #1e293b", marginBottom: "16px" }}>
          {STEPS.map((s) => {
            const currentIdx = STEPS.findIndex((x) => x.key === step);
            const thisIdx = STEPS.findIndex((x) => x.key === s.key);
            const isActive = s.key === step;
            const isPast = thisIdx < currentIdx;
            return (
              <div
                key={s.key}
                style={{
                  padding: "10px 16px",
                  borderBottom: isActive ? "2px solid #38bdf8" : "none",
                  color: isActive ? "#38bdf8" : isPast ? "#4ade80" : "#94a3b8",
                  fontWeight: 600,
                  fontSize: "12px",
                }}
              >
                {isPast ? "✓ " : ""}
                {s.label}
              </div>
            );
          })}
        </div>

        {errorMessage && (
          <div
            style={{
              padding: "10px 12px",
              marginBottom: "12px",
              backgroundColor: "#450a0a",
              border: "1px solid #991b1b",
              borderRadius: "4px",
              color: "#fca5a5",
              fontSize: "12px",
            }}
          >
            {errorMessage}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto" }}>
          {step === "UPLOAD" && (
            <div>
              <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" }}>FILE</label>
              <input
                type="file"
                accept=".xml,.csv,.json"
                onChange={handleFileChange}
                style={{ display: "block", marginBottom: "12px", fontSize: "12px", color: "#e2e8f0" }}
              />
              {fileName && <div style={{ fontSize: "11px", color: "#4ade80", marginBottom: "12px" }}>Selected: {fileName}</div>}

              <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" }}>FORMAT</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as FieldFormatId)}
                style={{
                  width: "100%",
                  padding: "8px",
                  marginBottom: "4px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: "4px",
                  color: "#e2e8f0",
                  fontSize: "12px",
                }}
              >
                {FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: "10px", color: "#64748b", marginBottom: "12px" }}>
                TestRail CSV can never be auto-detected -- select it explicitly if that's your file.
              </div>

              <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" }}>PROJECT</label>
              <select
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: "4px",
                  color: "#e2e8f0",
                  fontSize: "12px",
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {step === "MAPPING" && dryRunResult && (
            <div style={{ display: "flex", gap: "20px", height: "360px" }}>
              <div
                style={{
                  width: "260px",
                  backgroundColor: "#1e293b",
                  borderRadius: "6px",
                  border: "1px solid #334155",
                  overflowY: "auto",
                }}
              >
                <div style={{ padding: "10px", fontSize: "11px", color: "#94a3b8", fontWeight: 700, borderBottom: "1px solid #334155" }}>
                  UNMAPPED FIELDS ({dryRunResult.unmapped_custom_fields.length})
                </div>
                {dryRunResult.unmapped_custom_fields.length === 0 ? (
                  <div style={{ padding: "10px", fontSize: "12px", color: "#64748b" }}>No unmapped fields -- every column matched.</div>
                ) : (
                  dryRunResult.unmapped_custom_fields.map((f) => {
                    const resolved = fieldMappings[f.incoming_key];
                    return (
                      <div
                        key={f.incoming_key}
                        onClick={() => setSelectedUnmappedKey(f.incoming_key)}
                        style={{
                          padding: "10px",
                          cursor: "pointer",
                          backgroundColor: selectedUnmappedKey === f.incoming_key ? "#0284c7" : "transparent",
                          borderBottom: "1px solid #0f172a",
                        }}
                      >
                        <div style={{ fontSize: "12px", fontWeight: 600 }}>{f.incoming_key}</div>
                        <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                          {resolved ? `✓ ${resolved.action}` : `detected: ${f.detected_type}`}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ flex: 1, backgroundColor: "#1e293b", borderRadius: "6px", border: "1px solid #334155", padding: "14px", overflowY: "auto" }}>
                {!selectedUnmapped ? (
                  <div style={{ color: "#64748b", fontSize: "13px" }}>Select an unmapped field from the list to resolve it.</div>
                ) : (
                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "13px" }}>{selectedUnmapped.incoming_key}</h4>
                    <div style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "12px" }}>
                      Sample values: {(selectedUnmapped.sample_values && selectedUnmapped.sample_values.length > 0
                        ? selectedUnmapped.sample_values
                        : [selectedUnmapped.sample_value]
                      ).join(", ") || "(none)"}{" "}
                      -- detected type: {selectedUnmapped.detected_type}
                    </div>

                    <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                      <button
                        onClick={() => setMappingFor(selectedUnmapped.incoming_key, { action: "DROP" })}
                        style={mappingActionButtonStyle(selectedChoice?.action === "DROP")}
                      >
                        Drop
                      </button>
                      <button
                        onClick={() =>
                          setMappingFor(selectedUnmapped.incoming_key, {
                            action: "ROUTE_TO_EXISTING",
                            target_field_id: fieldOptions[0]?.id,
                          })
                        }
                        style={mappingActionButtonStyle(selectedChoice?.action === "ROUTE_TO_EXISTING")}
                      >
                        Map to Existing
                      </button>
                      <button
                        onClick={() =>
                          setMappingFor(selectedUnmapped.incoming_key, {
                            action: "AUTO_CREATE",
                            field_name: selectedUnmapped.incoming_key,
                            field_type: CREATABLE_FIELD_TYPES.includes(selectedUnmapped.detected_type)
                              ? selectedUnmapped.detected_type
                              : "TEXT",
                          })
                        }
                        style={mappingActionButtonStyle(selectedChoice?.action === "AUTO_CREATE")}
                      >
                        Create New
                      </button>
                    </div>

                    {selectedChoice?.action === "ROUTE_TO_EXISTING" && (
                      <div>
                        <label style={{ fontSize: "10px", color: "#64748b", display: "block", marginBottom: "4px" }}>
                          TARGET FIELD
                        </label>
                        <select
                          value={selectedChoice.target_field_id || ""}
                          onChange={(e) =>
                            setMappingFor(selectedUnmapped.incoming_key, { ...selectedChoice, target_field_id: e.target.value })
                          }
                          style={selectStyle}
                        >
                          {fieldOptions.length === 0 && <option value="">No existing fields available</option>}
                          {fieldOptions.some((f) => f.project_id === null) && (
                            <optgroup label="Global">
                              {fieldOptions
                                .filter((f) => f.project_id === null)
                                .map((f) => (
                                  <option key={f.id} value={f.id}>
                                    {f.field_label} ({f.field_type})
                                  </option>
                                ))}
                            </optgroup>
                          )}
                          {fieldOptions.some((f) => f.project_id !== null) && (
                            <optgroup label="This Project">
                              {fieldOptions
                                .filter((f) => f.project_id !== null)
                                .map((f) => (
                                  <option key={f.id} value={f.id}>
                                    {f.field_label} ({f.field_type})
                                  </option>
                                ))}
                            </optgroup>
                          )}
                        </select>
                      </div>
                    )}

                    {selectedChoice?.action === "AUTO_CREATE" && (
                      <div>
                        <label style={{ fontSize: "10px", color: "#64748b", display: "block", marginBottom: "4px" }}>FIELD LABEL</label>
                        <input
                          type="text"
                          value={selectedChoice.field_name || ""}
                          onChange={(e) =>
                            setMappingFor(selectedUnmapped.incoming_key, { ...selectedChoice, field_name: e.target.value })
                          }
                          style={{ ...selectStyle, marginBottom: "10px" }}
                        />
                        <label style={{ fontSize: "10px", color: "#64748b", display: "block", marginBottom: "4px" }}>FIELD TYPE</label>
                        <select
                          value={selectedChoice.field_type || "TEXT"}
                          onChange={(e) =>
                            setMappingFor(selectedUnmapped.incoming_key, {
                              ...selectedChoice,
                              field_type: e.target.value as CustomFieldType,
                            })
                          }
                          style={selectStyle}
                        >
                          {CREATABLE_FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        {(selectedChoice.field_type === "SINGLE_SELECT" || selectedChoice.field_type === "MULTI_SELECT") &&
                          (() => {
                            const options = previewSelectOptions(selectedUnmapped, selectedChoice.field_type!);
                            return (
                              <div style={{ marginTop: "8px" }}>
                                <div style={{ fontSize: "10px", color: "#64748b", marginBottom: "4px" }}>
                                  {selectedChoice.field_type === "MULTI_SELECT"
                                    ? "Options (comma-separated values are split into separate options):"
                                    : "Options (one per distinct value):"}{" "}
                                  {options.length}
                                  {selectedUnmapped.distinct_values_truncated ? "+" : ""}
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", maxHeight: "96px", overflowY: "auto" }}>
                                  {options.map((o) => (
                                    <span
                                      key={o}
                                      style={{
                                        fontSize: "10px",
                                        padding: "2px 6px",
                                        borderRadius: "4px",
                                        border: "1px solid #334155",
                                        color: "#cbd5e1",
                                      }}
                                    >
                                      {o}
                                    </span>
                                  ))}
                                </div>
                                {selectedUnmapped.distinct_values_truncated && (
                                  <div style={{ fontSize: "10px", color: "#fbbf24", marginTop: "4px" }}>
                                    Showing the first {selectedUnmapped.distinct_values?.length} values; every distinct value in the file becomes an option.
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === "DUPLICATES" && dryRunResult && (
            <div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                {[
                  ["Suites to create", dryRunResult.dry_run_summary.suites_to_create],
                  ["Cases to create", dryRunResult.dry_run_summary.cases_to_create],
                  ["Cases to version-up", dryRunResult.dry_run_summary.cases_to_version_up],
                  ["Cases to overwrite", dryRunResult.dry_run_summary.cases_to_overwrite],
                  ["Cases to skip", dryRunResult.dry_run_summary.cases_skipped],
                ].map(([label, value]) => (
                  <div
                    key={label as string}
                    style={{
                      flex: "1 1 140px",
                      backgroundColor: "#1e293b",
                      border: "1px solid #334155",
                      borderRadius: "6px",
                      padding: "10px",
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: "20px", fontWeight: 700, color: "#38bdf8" }}>{value as number}</div>
                    <div style={{ fontSize: "10px", color: "#94a3b8" }}>{label}</div>
                  </div>
                ))}
              </div>

              <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" }}>
                WHEN A CASE ALREADY EXISTS (BY EXTERNAL ID OR TITLE+SUITE)
              </label>
              <select value={duplicateAction} onChange={(e) => setDuplicateAction(e.target.value as DuplicateAction)} style={selectStyle}>
                <option value="VERSION_UP">Create a new version (recommended)</option>
                <option value="OVERWRITE">Overwrite the latest version</option>
                <option value="CREATE_NEW">Create a new, separate case</option>
                <option value="SKIP">Skip it</option>
              </select>

              {dryRunResult.warnings.length > 0 && (
                <div style={{ marginTop: "16px" }}>
                  <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" }}>
                    WARNINGS ({dryRunResult.warnings.length})
                  </label>
                  <div style={{ maxHeight: "120px", overflowY: "auto" }}>
                    {dryRunResult.warnings.map((w, i) => (
                      <div key={i} style={{ fontSize: "11px", color: "#fca5a5", marginBottom: "6px" }}>
                        <div>
                          {w.code}: {w.message}
                        </div>
                        {(w.case_title || w.case_external_id) && (
                          <div style={{ color: "#cbd5e1" }}>
                            {w.case_external_id ? `${w.case_external_id} -- ` : ""}
                            {w.case_title}
                            {w.suite_path ? <span style={{ color: "#64748b" }}> (in {w.suite_path})</span> : null}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "CONFIRM" && dryRunResult && (
            <div>
              <div style={{ fontSize: "13px", marginBottom: "10px" }}>
                Ready to import into <strong>{projects.find((p) => p.id === targetProjectId)?.name}</strong>.
              </div>
              <ul style={{ fontSize: "12px", color: "#cbd5e1", lineHeight: 1.8 }}>
                <li>Format: {format || "Auto-detect"}</li>
                <li>File: {fileName}</li>
                <li>
                  Field mappings: {Object.keys(fieldMappings).length} resolved
                  {unresolvedCount > 0 ? `, ${unresolvedCount} left unmapped (will be dropped)` : ""}
                </li>
                <li>Duplicate handling: {duplicateAction}</li>
                <li>Suites to create: {dryRunResult.dry_run_summary.suites_to_create}</li>
                <li>Cases to create/version-up/overwrite/skip: {dryRunResult.dry_run_summary.cases_to_create}/
                  {dryRunResult.dry_run_summary.cases_to_version_up}/{dryRunResult.dry_run_summary.cases_to_overwrite}/
                  {dryRunResult.dry_run_summary.cases_skipped}</li>
              </ul>
            </div>
          )}

          {step === "RESULTS" && executeResult && (
            <div>
              <div
                style={{
                  padding: "12px",
                  marginBottom: "16px",
                  backgroundColor: "rgba(34, 197, 94, 0.1)",
                  border: "1px solid #22c55e",
                  borderRadius: "6px",
                  color: "#4ade80",
                  fontSize: "13px",
                  fontWeight: 700,
                }}
              >
                ✓ Import complete
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                {[
                  ["Suites imported", executeResult.summary.imported_suites_count],
                  ["Cases imported", executeResult.summary.imported_cases_count],
                  ["Versions created", executeResult.summary.created_versions_count],
                  ["Cases overwritten", executeResult.summary.overwritten_cases_count],
                  ["Cases skipped", executeResult.summary.skipped_cases_count],
                  ["Fields auto-created", executeResult.summary.auto_created_custom_fields_count],
                  ["Field values skipped", executeResult.summary.skipped_custom_field_values_count],
                ].map(([label, value]) => (
                  <div
                    key={label as string}
                    style={{
                      flex: "1 1 140px",
                      backgroundColor: "#1e293b",
                      border: "1px solid #334155",
                      borderRadius: "6px",
                      padding: "10px",
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: "20px", fontWeight: 700, color: "#38bdf8" }}>{value as number}</div>
                    <div style={{ fontSize: "10px", color: "#94a3b8" }}>{label}</div>
                  </div>
                ))}
              </div>

              {executeResult.skipped_custom_field_value_warnings && executeResult.skipped_custom_field_value_warnings.length > 0 && (
                <div>
                  <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" }}>
                    SKIPPED FIELD VALUES
                  </label>
                  <div style={{ maxHeight: "120px", overflowY: "auto" }}>
                    {executeResult.skipped_custom_field_value_warnings.map((w, i) => (
                      <div key={i} style={{ fontSize: "11px", color: "#fca5a5", marginBottom: "4px" }}>
                        {w.case_external_id_or_title} / {w.incoming_key}: {w.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "16px", paddingTop: "16px", borderTop: "1px solid #1e293b" }}>
          <div>
            {step !== "UPLOAD" && step !== "RESULTS" && (
              <button
                onClick={() =>
                  setStep(step === "MAPPING" ? "UPLOAD" : step === "DUPLICATES" ? "MAPPING" : "DUPLICATES")
                }
                style={secondaryButtonStyle}
              >
                ← Back
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {step === "UPLOAD" && (
              <button onClick={handleUploadNext} disabled={isLoading} style={primaryButtonStyle(isLoading)}>
                {isLoading ? "Previewing..." : "Preview Import →"}
              </button>
            )}
            {step === "MAPPING" && (
              <button onClick={handleMappingNext} disabled={isLoading} style={primaryButtonStyle(isLoading)}>
                {isLoading ? "Refreshing..." : "Next →"}
              </button>
            )}
            {step === "DUPLICATES" && (
              <button onClick={handleDuplicatesNext} disabled={isLoading} style={primaryButtonStyle(isLoading)}>
                {isLoading ? "Refreshing..." : "Next →"}
              </button>
            )}
            {step === "CONFIRM" && (
              <button onClick={handleExecute} disabled={isLoading} style={primaryButtonStyle(isLoading)}>
                {isLoading ? "Importing..." : "Run Import"}
              </button>
            )}
            {step === "RESULTS" && (
              <>
                <button onClick={resetWizard} style={secondaryButtonStyle}>
                  Import Another File
                </button>
                <button onClick={onClose} style={primaryButtonStyle(false)}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#e2e8f0",
  fontSize: "12px",
  boxSizing: "border-box",
};

function mappingActionButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 700,
    border: active ? "1px solid #22c55e" : "1px solid #4b5563",
    backgroundColor: active ? "rgba(34, 197, 94, 0.15)" : "transparent",
    color: active ? "#4ade80" : "#9ca3af",
    cursor: "pointer",
  };
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  backgroundColor: "transparent",
  border: "1px solid #4b5563",
  borderRadius: "4px",
  color: "#9ca3af",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    backgroundColor: disabled ? "#166534" : "#16a34a",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    fontWeight: 600,
    fontSize: "12px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.8 : 1,
  };
}
