import React from "react";
import type { CustomFieldValueEntry } from "../App";

interface CustomFieldEditorProps {
  entry: CustomFieldValueEntry;
  onChange: (value: unknown) => void;
  disabled: boolean;
  disabledTitle?: string;
  errorMessage?: string | null;
  isSaving?: boolean;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  backgroundColor: "#0d111c",
  border: "1px solid #1f2937",
  borderRadius: "4px",
  color: "#f8fafc",
  fontSize: "12px",
};

function autoGrowTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** Renders a live editor for one custom field value, matching its field_type. Shared by the
 * Spec-mode case detail pane and Suite Details pane (both in App.tsx) so the 6-type switch
 * isn't duplicated. Pure props-in/callback-out -- does no fetching of its own. */
export function CustomFieldEditor({ entry, onChange, disabled, disabledTitle, errorMessage, isSaving }: CustomFieldEditorProps) {
  const { definition, value } = entry;

  const renderControl = () => {
    switch (definition.field_type) {
      case "TEXT":
        return (
          <textarea
            ref={(el) => {
              // Only size on genuine mount -- this inline callback is a fresh identity every
              // render, so React re-invokes it on every commit, and resetting height to auto
              // each time briefly collapses the field (shrinking the scroll container's
              // scrollHeight mid-commit). Live growth is covered by onInput below.
              if (el && !el.style.height) autoGrowTextarea(el);
            }}
            defaultValue={(value as string) ?? ""}
            onBlur={(e) => onChange(e.target.value || null)}
            onInput={(e) => autoGrowTextarea(e.currentTarget)}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            rows={1}
            style={{ ...inputStyle, opacity: disabled ? 0.6 : 1, resize: "none", overflow: "hidden" }}
          />
        );

      case "NUMBER":
        return (
          <input
            type="number"
            defaultValue={value === null || value === undefined ? "" : String(value)}
            onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
          />
        );

      case "DATE":
        return (
          <input
            type="date"
            defaultValue={(value as string) ?? ""}
            onBlur={(e) => onChange(e.target.value || null)}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
          />
        );

      case "CHECKBOX": {
        // No checkmark glyph -- too small to read at 16px. The filled green square/border
        // is the on/off signal by itself, matching the SPEC_AUTO_APPROVE-adjacent tri-state
        // indicators elsewhere in this app that also communicate state through fill alone.
        const isOn = value === true;
        return (
          <button
            onClick={() => !disabled && onChange(!isOn)}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            style={{
              width: "16px",
              height: "16px",
              borderRadius: "3px",
              border: isOn ? "1px solid #22c55e" : "1px solid #4b5563",
              backgroundColor: isOn ? "#15803d" : "transparent",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
            }}
          />
        );
      }

      case "SINGLE_SELECT":
        return (
          <select
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
          >
            <option value="">—</option>
            {definition.options.map((o) => (
              <option key={o.option_value} value={o.option_value}>
                {o.option_label}
              </option>
            ))}
          </select>
        );

      case "MULTI_SELECT": {
        const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
        return (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {definition.options.map((o) => {
              const isOn = selected.has(o.option_value);
              return (
                <button
                  key={o.option_value}
                  onClick={() => {
                    if (disabled) return;
                    const next = new Set(selected);
                    if (isOn) next.delete(o.option_value);
                    else next.add(o.option_value);
                    onChange(Array.from(next));
                  }}
                  disabled={disabled}
                  title={disabled ? disabledTitle : undefined}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "4px",
                    fontSize: "10px",
                    fontWeight: 700,
                    border: isOn ? "1px solid #22c55e" : "1px solid #4b5563",
                    backgroundColor: isOn ? "rgba(34, 197, 94, 0.15)" : "transparent",
                    color: isOn ? "#4ade80" : "#9ca3af",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  {isOn ? "✓" : "—"} {o.option_label}
                </button>
              );
            })}
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div
      style={{
        backgroundColor: "#111827",
        padding: "12px",
        borderRadius: "6px",
        border: "1px solid #1f2937",
        marginBottom: "10px",
      }}
    >
      <div style={{ fontSize: "11px", color: "#6b7280", textTransform: "uppercase", marginBottom: "6px" }}>
        {definition.field_label}
        {definition.is_required ? " *" : ""}
        {isSaving ? <span style={{ color: "#38bdf8", marginLeft: "6px", textTransform: "none" }}>Saving...</span> : null}
      </div>
      {renderControl()}
      {errorMessage && (
        <div style={{ fontSize: "11px", color: "#f87171", marginTop: "4px" }}>{errorMessage}</div>
      )}
    </div>
  );
}
