import React from "react";

/** Mirrors @testify/core's CaseFilterFieldDescriptor (GET .../case-search/fields) -- the web
 * app doesn't depend on @testify/core, so the shape is restated here. */
export interface CaseFilterField {
  key: string;
  label: string;
  kind: "ENUM" | "BOOLEAN" | "TEXT" | "NUMBER" | "DATE" | "CHECKBOX" | "SINGLE_SELECT" | "MULTI_SELECT";
  source: "builtin" | "case_custom_field" | "suite_custom_field";
  options?: Array<{ value: string; label: string }>;
  requires?: "plan_id" | "build_id";
}

/** One row in the panel. `field` is "" until a property is picked. Value shape per kind:
 * ENUM/SINGLE_SELECT/MULTI_SELECT: string[] (any_of; MULTI_SELECT may use all_of);
 * TEXT: string; NUMBER/DATE: { min, max } strings; BOOLEAN/CHECKBOX: boolean | null. */
export interface CaseFilterRow {
  id: string;
  field: string;
  op: "any_of" | "all_of" | "contains" | "range" | "is";
  value: unknown;
}

export interface CaseFilterState {
  q: string;
  filters: CaseFilterRow[];
}

export const EMPTY_CASE_FILTER: CaseFilterState = { q: "", filters: [] };

/** Rows whose property is unavailable here (e.g. Verdict in Spec mode) are kept on screen
 * but dimmed -- switching modes back and forth shouldn't silently delete a filter. */
export function isFieldAvailable(
  field: CaseFilterField,
  ctx: { mode: "EXECUTION" | "SPECIFICATION"; hasPlan: boolean; hasRun: boolean },
): boolean {
  if (field.key === "verdict") return ctx.mode === "EXECUTION" && ctx.hasRun;
  if (field.requires === "plan_id") return ctx.hasPlan;
  if (field.requires === "build_id") return ctx.hasRun;
  return true;
}

/** Converts panel rows into the API's filter list, dropping rows that don't have a usable
 * value yet (so adding a filter never momentarily empties the list) or whose field isn't
 * available in the current context. */
export function toApiFilters(
  rows: CaseFilterRow[],
  fieldsByKey: Map<string, CaseFilterField>,
  isAvailable: (f: CaseFilterField) => boolean,
): Array<{ field: string; op: string; value?: unknown }> {
  const out: Array<{ field: string; op: string; value?: unknown }> = [];
  for (const row of rows) {
    const field = fieldsByKey.get(row.field);
    if (!field || !isAvailable(field)) continue;
    switch (row.op) {
      case "any_of":
      case "all_of":
        if (Array.isArray(row.value) && row.value.length > 0) out.push({ field: row.field, op: row.op, value: row.value });
        break;
      case "contains":
        if (typeof row.value === "string" && row.value.trim()) out.push({ field: row.field, op: "contains", value: row.value });
        break;
      case "is":
        if (typeof row.value === "boolean") out.push({ field: row.field, op: "is", value: row.value });
        break;
      case "range": {
        const { min = "", max = "" } = (row.value || {}) as { min?: string; max?: string };
        const lo = min.trim();
        const hi = max.trim();
        if (lo && hi) out.push({ field: row.field, op: "between", value: [lo, hi] });
        else if (lo) out.push({ field: row.field, op: "gte", value: lo });
        else if (hi) out.push({ field: row.field, op: "lte", value: hi });
        break;
      }
    }
  }
  return out;
}

function defaultRowFor(field: CaseFilterField): Pick<CaseFilterRow, "op" | "value"> {
  switch (field.kind) {
    case "TEXT":
      return { op: "contains", value: "" };
    case "NUMBER":
    case "DATE":
      return { op: "range", value: { min: "", max: "" } };
    case "BOOLEAN":
    case "CHECKBOX":
      return { op: "is", value: null };
    default:
      return { op: "any_of", value: [] };
  }
}

let rowSeq = 0;
const newRowId = () => `f${Date.now().toString(36)}${(rowSeq++).toString(36)}`;

const pillStyle = (on: boolean): React.CSSProperties => ({
  padding: "2px 6px",
  borderRadius: "4px",
  fontSize: "10px",
  fontWeight: 700,
  border: on ? "1px solid #22c55e" : "1px solid #4b5563",
  backgroundColor: on ? "rgba(34, 197, 94, 0.15)" : "transparent",
  color: on ? "#4ade80" : "#9ca3af",
  cursor: "pointer",
});

const inputStyle: React.CSSProperties = {
  backgroundColor: "#0b0f19",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#e5e7eb",
  fontSize: "11px",
  padding: "3px 6px",
  boxSizing: "border-box",
  minWidth: 0,
};

export interface CaseFilterPanelProps {
  value: CaseFilterState;
  onChange: (next: CaseFilterState) => void;
  fields: CaseFilterField[];
  mode: "EXECUTION" | "SPECIFICATION";
  hasPlan: boolean;
  hasRun: boolean;
  searchInputRef: React.RefObject<HTMLInputElement>;
  /** null when no search/filter is active. */
  matchCount: number | null;
  totalCount: number;
  /** Called when "+ Filter" is clicked, so the field catalog can be refreshed (picks up
   * custom fields added in the Admin Panel since the project loaded). */
  onRequestFields?: () => void;
}

export const CaseFilterPanel: React.FC<CaseFilterPanelProps> = ({
  value,
  onChange,
  fields,
  mode,
  hasPlan,
  hasRun,
  searchInputRef,
  matchCount,
  totalCount,
  onRequestFields,
}) => {
  const fieldsByKey = new Map(fields.map((f) => [f.key, f]));
  const ctx = { mode, hasPlan, hasRun };

  const updateRow = (id: string, patch: Partial<CaseFilterRow>) =>
    onChange({ ...value, filters: value.filters.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const removeRow = (id: string) => onChange({ ...value, filters: value.filters.filter((r) => r.id !== id) });
  const addRow = () => {
    onRequestFields?.();
    onChange({ ...value, filters: [...value.filters, { id: newRowId(), field: "", op: "any_of", value: [] }] });
  };

  const groups: Array<{ label: string; source: CaseFilterField["source"] }> = [
    { label: "Built-in", source: "builtin" },
    { label: "Case fields", source: "case_custom_field" },
    { label: "Suite fields", source: "suite_custom_field" },
  ];

  const renderValueControl = (row: CaseFilterRow, field: CaseFilterField) => {
    switch (field.kind) {
      case "ENUM":
      case "SINGLE_SELECT":
      case "MULTI_SELECT": {
        const selected = new Set(Array.isArray(row.value) ? (row.value as string[]) : []);
        return (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            {(field.options || []).map((o) => {
              const on = selected.has(o.value);
              return (
                <button
                  key={o.value}
                  onClick={() => {
                    const next = new Set(selected);
                    if (on) next.delete(o.value);
                    else next.add(o.value);
                    updateRow(row.id, { value: Array.from(next) });
                  }}
                  style={pillStyle(on)}
                >
                  {on ? "✓" : "—"} {o.label}
                </button>
              );
            })}
            {(field.options || []).length === 0 && (
              <span style={{ fontSize: "10px", color: "#6b7280" }}>No options defined.</span>
            )}
            {field.kind === "MULTI_SELECT" && (
              <button
                onClick={() => updateRow(row.id, { op: row.op === "all_of" ? "any_of" : "all_of" })}
                title="Match cases having ANY of the selected options, or ALL of them"
                style={{ ...pillStyle(false), color: "#93c5fd", borderColor: "#1e3a8a" }}
              >
                {row.op === "all_of" ? "all" : "any"}
              </button>
            )}
          </div>
        );
      }
      case "TEXT":
        return (
          <input
            value={(row.value as string) || ""}
            onChange={(e) => updateRow(row.id, { value: e.target.value })}
            placeholder="contains…"
            style={{ ...inputStyle, width: "100%" }}
          />
        );
      case "NUMBER":
      case "DATE": {
        const { min = "", max = "" } = (row.value || {}) as { min?: string; max?: string };
        const type = field.kind === "NUMBER" ? "number" : "date";
        return (
          <div style={{ display: "flex", gap: "4px", alignItems: "center", width: "100%" }}>
            <input
              type={type}
              value={min}
              onChange={(e) => updateRow(row.id, { value: { min: e.target.value, max } })}
              placeholder="min"
              style={{ ...inputStyle, flex: 1 }}
            />
            <span style={{ color: "#6b7280", fontSize: "10px" }}>–</span>
            <input
              type={type}
              value={max}
              onChange={(e) => updateRow(row.id, { value: { min, max: e.target.value } })}
              placeholder="max"
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>
        );
      }
      case "BOOLEAN":
      case "CHECKBOX":
        return (
          <div style={{ display: "flex", gap: "4px" }}>
            {[true, false].map((b) => (
              <button
                key={String(b)}
                onClick={() => updateRow(row.id, { value: row.value === b ? null : b })}
                style={pillStyle(row.value === b)}
              >
                {b ? "Yes" : "No"}
              </button>
            ))}
          </div>
        );
    }
  };

  const isActive = value.q.trim() !== "" || value.filters.length > 0;

  return (
    <div
      // The global hotkey engine treats Ctrl/Cmd+Enter in ANY input as "submit notes and
      // record a verdict" -- never let that fire from the search/filter controls.
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.stopPropagation();
      }}
      style={{ padding: "8px 12px", borderBottom: "1px solid #1f2937", display: "flex", flexDirection: "column", gap: "6px" }}
    >
      <input
        ref={searchInputRef}
        value={value.q}
        onChange={(e) => onChange({ ...value, q: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
        placeholder="Search ID or title  ( / )"
        style={{ ...inputStyle, width: "100%", padding: "5px 8px" }}
      />

      {value.filters.map((row) => {
        const field = fieldsByKey.get(row.field);
        const available = !field || isFieldAvailable(field, ctx);
        return (
          <div
            key={row.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              padding: "5px 6px",
              border: "1px solid #1f2937",
              borderRadius: "4px",
              backgroundColor: "#0b0f19",
              opacity: available ? 1 : 0.5,
            }}
          >
            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
              <select
                value={row.field}
                onChange={(e) => {
                  const next = fieldsByKey.get(e.target.value);
                  updateRow(row.id, { field: e.target.value, ...(next ? defaultRowFor(next) : { op: "any_of", value: [] }) });
                }}
                style={{ ...inputStyle, flex: 1 }}
              >
                <option value="">Choose property…</option>
                {groups.map((g) => {
                  const opts = fields.filter((f) => f.source === g.source && (isFieldAvailable(f, ctx) || f.key === row.field));
                  if (opts.length === 0) return null;
                  return (
                    <optgroup key={g.source} label={g.label}>
                      {opts.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <button
                onClick={() => removeRow(row.id)}
                title="Remove filter"
                style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "12px", padding: "0 2px" }}
              >
                ×
              </button>
            </div>
            {field && renderValueControl(row, field)}
            {field && !available && (
              <span style={{ fontSize: "10px", color: "#6b7280" }}>
                Not applicable here (needs {field.key === "verdict" ? "Execute mode and a run" : field.requires === "plan_id" ? "a plan" : "a run"}).
              </span>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "10px" }}>
        <button
          onClick={addRow}
          style={{ background: "transparent", border: "1px solid #334155", borderRadius: "4px", color: "#9ca3af", fontSize: "10px", fontWeight: 700, padding: "2px 8px", cursor: "pointer" }}
        >
          + Filter
        </button>
        {matchCount !== null && (
          <span style={{ color: "#9ca3af" }}>
            {matchCount} of {totalCount} cases
          </span>
        )}
        {isActive && (
          <button
            onClick={() => onChange(EMPTY_CASE_FILTER)}
            style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#60a5fa", fontSize: "10px", cursor: "pointer", padding: 0 }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
};
