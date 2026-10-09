import React, { useCallback, useEffect, useState } from "react";
import { authHeaders, jsonHeaders } from "../utils/session";

interface EmailSettings {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  has_password: boolean;
  /** A password is saved but the server can't decrypt it (its SECRETS_KEY is missing or changed). */
  password_unreadable?: boolean;
  /** False when the server has no SECRETS_KEY, so it can't store a password. */
  can_store_password?: boolean;
  from: string | null;
  public_url: string | null;
  delivery: "smtp" | "capture_only";
}

interface LastEmail {
  schedule_id: string | null;
  subject: string;
  recipients: string[];
  html: string;
  status: "SENT" | "CAPTURED" | "FAILED";
  error: string | null;
  created_at: string;
}


const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#e2e8f0",
  fontSize: "12px",
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = { fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" };
const buttonStyle: React.CSSProperties = {
  padding: "7px 14px",
  borderRadius: "4px",
  border: "1px solid #334155",
  backgroundColor: "transparent",
  color: "#cbd5e1",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
};
const STATUS_COLORS: Record<string, string> = { SENT: "#4ade80", CAPTURED: "#7dd3fc", FAILED: "#f87171" };
const lastEmailLabel: React.CSSProperties = { color: "#64748b", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", paddingTop: "2px" };
const lastEmailValue: React.CSSProperties = { color: "#e2e8f0", minWidth: 0, overflowWrap: "anywhere" };

/** Admin Panel "Email" tab: outgoing mail server settings and the last email sent. */
export function EmailSettingsPanel() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [form, setForm] = useState({ smtp_host: "", smtp_port: "", smtp_secure: false, smtp_user: "", smtp_password: "", from: "", public_url: "" });
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastEmail, setLastEmail] = useState<LastEmail | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);

  const applySettings = (s: EmailSettings) => {
    setSettings(s);
    setForm({
      smtp_host: s.smtp_host ?? "",
      smtp_port: s.smtp_port ? String(s.smtp_port) : "",
      smtp_secure: s.smtp_secure,
      smtp_user: s.smtp_user ?? "",
      smtp_password: "",
      from: s.from ?? "",
      public_url: s.public_url ?? (typeof window !== "undefined" ? window.location.origin : ""),
    });
    setPasswordTouched(false);
  };

  const loadLastEmail = useCallback(async () => {
    const res = await fetch("/api/v1/admin/email-last", { headers: authHeaders() });
    if (res.ok) setLastEmail((await res.json()).email);
  }, []);

  useEffect(() => {
    fetch("/api/v1/admin/email-settings", { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Failed to load email settings (${r.status})`))))
      .then((d) => applySettings(d.settings))
      .catch((e) => setNotice({ ok: false, text: e.message }));
    loadLastEmail();
  }, [loadLastEmail]);

  const flash = (ok: boolean, text: string) => {
    setNotice({ ok, text });
    if (ok) setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 3500);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ...form, smtp_port: form.smtp_port || null };
      if (!passwordTouched) delete body.smtp_password;
      const res = await fetch("/api/v1/admin/email-settings", { method: "PUT", headers: jsonHeaders(), body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || d.error || "Couldn't save");
      applySettings(d.settings);
      flash(true, "✓ Email settings saved.");
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/admin/email-settings/test", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ to: testTo }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || d.error || "Couldn't send");
      if (d.email.status === "FAILED") flash(false, "Sending the test email failed -- see Last email below.");
      else flash(true, d.email.status === "SENT" ? `✓ Test email sent to ${testTo}.` : "✓ Test email captured (no SMTP server set, so nothing was sent).");
      loadLastEmail();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        value={form[key] as string}
        onChange={(e) => {
          setForm((f) => ({ ...f, [key]: e.target.value }));
          if (key === "smtp_password") setPasswordTouched(true);
        }}
        style={inputStyle}
        {...props}
      />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {notice && (
        <div
          style={{
            backgroundColor: notice.ok ? "#052e16" : "#450a0a",
            border: `1px solid ${notice.ok ? "#16a34a" : "#991b1b"}`,
            color: notice.ok ? "#86efac" : "#fca5a5",
            padding: "8px 12px",
            borderRadius: "6px",
            fontSize: "12px",
          }}
        >
          {notice.text}
        </div>
      )}

      <section style={{ backgroundColor: "#111827", border: "1px solid #1f2937", borderRadius: "8px", padding: "16px" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: "14px", color: "#e2e8f0" }}>Outgoing mail server (SMTP)</h3>
        <p style={{ margin: "0 0 12px", fontSize: "11px", color: "#64748b" }}>Used for report emails. Ask your IT team or email provider for these details.</p>
        {settings?.password_unreadable && (
          <div style={{ fontSize: "12px", color: "#fde68a", backgroundColor: "#78350f", border: "1px solid #92400e", borderRadius: "6px", padding: "8px 10px", marginBottom: "12px" }}>
            ⚠️ The saved SMTP password can't be read: the server's SECRETS_KEY is missing or has changed. Enter the password again and save.
          </div>
        )}
        {settings && settings.can_store_password === false && (
          <div style={{ fontSize: "12px", color: "#fde68a", backgroundColor: "#78350f", border: "1px solid #92400e", borderRadius: "6px", padding: "8px 10px", marginBottom: "12px" }}>
            ⚠️ The server has no SECRETS_KEY, so it can't store an SMTP password securely. Set SECRETS_KEY (32+ characters) in its environment and restart it to save one.
          </div>
        )}
        {settings?.delivery === "capture_only" && (
          <div style={{ fontSize: "12px", color: "#fde68a", backgroundColor: "#78350f", border: "1px solid #92400e", borderRadius: "6px", padding: "8px 10px", marginBottom: "12px" }}>
            No mail server is set, so report emails are only captured, not sent. The last one is shown below.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px" }}>
          {field("smtp_host", "SMTP HOST", { placeholder: "smtp.example.com" })}
          {field("smtp_port", "PORT", { placeholder: form.smtp_secure ? "465" : "587", inputMode: "numeric" })}
          {field("smtp_user", "USERNAME", { autoComplete: "off" })}
          {field("smtp_password", "PASSWORD", {
            type: "password",
            autoComplete: "new-password",
            placeholder: settings?.password_unreadable
              ? "Saved password unreadable — enter it again"
              : settings?.has_password
                ? "•••••••• (saved, encrypted — type to replace)"
                : "",
          })}
          {field("from", "FROM ADDRESS", { placeholder: "Testify <qa@example.com>" })}
          <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: "6px", marginTop: "20px", cursor: "pointer" }}>
            <input type="checkbox" checked={form.smtp_secure} onChange={(e) => setForm((f) => ({ ...f, smtp_secure: e.target.checked }))} />
            Use TLS from the start (usually port 465)
          </label>
        </div>
        <div style={{ marginTop: "10px" }}>
          {field("public_url", "TESTIFY ADDRESS FOR LINKS IN EMAILS", { placeholder: "https://testify.example.com" })}
        </div>
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={save} disabled={busy} style={{ ...buttonStyle, backgroundColor: "#0284c7", border: "none", color: "#fff" }}>
            {busy ? "Saving…" : "Save"}
          </button>
          {settings?.has_password && (
            <button
              onClick={() => {
                setForm((f) => ({ ...f, smtp_password: "" }));
                setPasswordTouched(true);
              }}
              style={buttonStyle}
              title="Remove the saved password when you next save"
            >
              Clear saved password
            </button>
          )}
          <span style={{ flex: 1 }} />
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" style={{ ...inputStyle, width: "220px" }} />
          <button onClick={sendTest} disabled={busy || !testTo.trim()} style={buttonStyle}>
            Send test email
          </button>
        </div>
      </section>

      <section style={{ backgroundColor: "#111827", border: "1px solid #1f2937", borderRadius: "8px", padding: "16px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "14px", color: "#e2e8f0", flex: 1 }}>Last email</h3>
          {lastEmail && (
            <button onClick={() => setPreview({ subject: lastEmail.subject, html: lastEmail.html })} style={{ ...buttonStyle, padding: "4px 10px", fontSize: "11px" }}>
              Preview
            </button>
          )}
          <button onClick={loadLastEmail} style={{ ...buttonStyle, padding: "4px 10px", fontSize: "11px" }}>
            Refresh
          </button>
        </div>
        {!lastEmail ? (
          <div style={{ fontSize: "12px", color: "#64748b" }}>No email sent yet.</div>
        ) : (
          // Two columns: labels sized to content, values take the rest and may shrink --
          // minWidth 0 + overflowWrap anywhere keep long subjects, address lists and error
          // messages inside the box instead of widening the modal.
          <div style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: "14px", rowGap: "8px", fontSize: "12px" }}>
            <div style={lastEmailLabel}>When</div>
            <div style={lastEmailValue}>{new Date(lastEmail.created_at).toLocaleString()}</div>
            <div style={lastEmailLabel}>Subject</div>
            <div style={lastEmailValue}>
              {lastEmail.subject}
              {lastEmail.schedule_id && <span style={{ color: "#64748b", fontSize: "11px" }}> · scheduled</span>}
            </div>
            <div style={lastEmailLabel}>To</div>
            <div style={lastEmailValue}>{lastEmail.recipients.join(", ")}</div>
            <div style={lastEmailLabel}>Status</div>
            <div style={lastEmailValue}>
              <span style={{ color: STATUS_COLORS[lastEmail.status], fontWeight: 700 }}>
                {lastEmail.status === "CAPTURED" ? "Captured (not sent)" : lastEmail.status === "SENT" ? "Sent" : "Failed"}
              </span>
              {lastEmail.error && (
                <div
                  style={{
                    marginTop: "6px",
                    padding: "6px 8px",
                    backgroundColor: "#1f0a0a",
                    border: "1px solid #7f1d1d",
                    borderRadius: "4px",
                    color: "#fca5a5",
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontSize: "11px",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: "160px",
                    overflowY: "auto",
                  }}
                >
                  {lastEmail.error}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {preview && <EmailPreviewModal subject={preview.subject} html={preview.html} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** Shows an email exactly as rendered, in a sandboxed iframe (no scripts, no same-origin access). */
export function EmailPreviewModal({ subject, html, onClose, actions }: { subject: string; html: string; onClose: () => void; actions?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, backgroundColor: "rgba(2, 6, 23, 0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(820px, 94vw)", height: "88vh", backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", borderBottom: "1px solid #1e293b" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "10px", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Email preview</div>
            <div style={{ fontSize: "13px", color: "#e2e8f0", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subject}</div>
          </div>
          {actions}
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer" }}>
            ×
          </button>
        </div>
        {/* Links open in a new tab (base target) so "Open in Testify" can be checked from here. */}
        <iframe
          title="Email preview"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={html.replace(/<html>/i, '<html><head><base target="_blank"></head>')}
          style={{ flex: 1, border: "none", backgroundColor: "#fff" }}
        />
      </div>
    </div>
  );
}
