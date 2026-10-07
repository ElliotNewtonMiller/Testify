import React from "react";
import { EmailPreviewModal } from "../EmailSettingsPanel";
import { buttonStyle } from "./shared";

/** One report in an email: a catalog report id and its params (same as the report API). */
export interface EmailSectionRequest {
  report_id: string;
  params: Record<string, unknown>;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#e2e8f0",
  fontSize: "12px",
  padding: "7px 9px",
  fontFamily: "inherit",
  resize: "vertical",
};

/**
 * "Email this report": sends what's on screen (the current tab's report, with its scope and
 * filter) to any addresses, with an optional note. Preview shows the exact email first.
 */
export function EmailReportDialog({ projectId, what, sections, onClose }: { projectId: string; what: string; sections: EmailSectionRequest[]; onClose: () => void }) {
  const [recipients, setRecipients] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ status: string; error: string | null; count: number } | null>(null);
  const [preview, setPreview] = React.useState<{ subject: string; html: string } | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !preview && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, preview]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/v1/projects/${projectId}/report-emails`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
    return data;
  };

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await post({ sections, message: message || null, preview: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post({ sections, recipients, message: message || null });
      setPreview(null);
      setDone({ status: data.outbox.status, error: data.outbox.error, count: data.outbox.recipients.length });
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, backgroundColor: "rgba(2, 6, 23, 0.6)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Email this report" style={{ width: "min(520px, 94vw)", backgroundColor: "#0b1120", border: "1px solid #334155", borderRadius: "8px", padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#f1f5f9" }}>✉ Email this report</div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: 2 }}>{what}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}>
            ×
          </button>
        </div>

        {done ? (
          <>
            <div
              style={{
                fontSize: "12px",
                padding: "10px 12px",
                borderRadius: "6px",
                color: done.status === "FAILED" ? "#fca5a5" : "#86efac",
                backgroundColor: done.status === "FAILED" ? "#450a0a" : "#052e16",
                border: `1px solid ${done.status === "FAILED" ? "#991b1b" : "#16a34a"}`,
              }}
            >
              {done.status === "SENT" && `✓ Sent to ${done.count} recipient${done.count === 1 ? "" : "s"}.`}
              {done.status === "CAPTURED" && "✓ Captured in the Admin Panel outbox -- no mail server is set up, so it wasn't actually sent."}
              {done.status === "FAILED" && `Sending failed: ${done.error}`}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={buttonStyle}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8" }}>
              TO
              <textarea
                autoFocus
                rows={2}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="stakeholder@example.com, qa-lead@example.com"
                style={{ ...fieldStyle, marginTop: 4 }}
              />
            </label>
            <label style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8" }}>
              NOTE (OPTIONAL)
              <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="A few words shown above the report" maxLength={2000} style={{ ...fieldStyle, marginTop: 4 }} />
            </label>
            {error && <div style={{ fontSize: "12px", color: "#f87171" }}>⚠️ {error}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={doPreview} disabled={busy} style={buttonStyle}>
                Preview
              </button>
              <button onClick={send} disabled={busy || !recipients.trim()} style={{ ...buttonStyle, backgroundColor: "#0284c7", border: "none", color: "#fff", opacity: busy || !recipients.trim() ? 0.5 : 1 }}>
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>

      {preview && (
        // Its own click handling: closing the preview mustn't also close this dialog.
        <div onClick={(e) => e.stopPropagation()}>
        <EmailPreviewModal
          subject={preview.subject}
          html={preview.html}
          onClose={() => setPreview(null)}
          actions={
            <button onClick={send} disabled={busy || !recipients.trim()} title={recipients.trim() ? "" : "Add recipients first"} style={{ ...buttonStyle, backgroundColor: "#0284c7", border: "none", color: "#fff", opacity: busy || !recipients.trim() ? 0.5 : 1 }}>
              {busy ? "Sending…" : "Send"}
            </button>
          }
        />
        </div>
      )}
    </div>
  );
}
