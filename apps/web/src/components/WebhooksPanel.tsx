import React, { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, jsonHeaders } from "../utils/session";
import { errorMessage } from "../api/errors";
import { api } from "../api/routes";

/**
 * Admin Panel "Webhooks" tab: a project's webhooks (where its events go), their signing secrets,
 * and each one's delivery log. Needs WEBHOOK_MANAGE in the project. The server side is
 * apps/server/src/routes/webhooks.ts; the events and envelope are RFC 03 §7.3.
 */

interface ProjectOption {
  id: string;
  name: string;
  permissions?: string[];
}

interface WebhookEvent {
  key: string;
  group: string;
  description: string;
}

interface DeliverySummary {
  id: string;
  event: string;
  event_id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface Delivery extends DeliverySummary {
  payload: unknown;
  response_body: string | null;
}

interface Webhook {
  id: string;
  name: string;
  url: string;
  format: "json" | "slack";
  events: string[];
  enabled: boolean;
  secret_hint: string | null;
  created_at: string;
  last_delivery: DeliverySummary | null;
}

type FormState = { id: string | null; name: string; url: string; format: "json" | "slack"; events: string[] };

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
  padding: "6px 12px",
  borderRadius: "4px",
  border: "1px solid #334155",
  backgroundColor: "transparent",
  color: "#cbd5e1",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
};
const smallButton: React.CSSProperties = { ...buttonStyle, padding: "3px 9px", fontSize: "11px" };
const primaryButton: React.CSSProperties = { ...buttonStyle, backgroundColor: "#0284c7", border: "none", color: "#fff" };
const amberBanner: React.CSSProperties = {
  fontSize: "12px",
  color: "#fde68a",
  backgroundColor: "#78350f",
  border: "1px solid #92400e",
  borderRadius: "6px",
  padding: "8px 10px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
};
const codeBox: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: "11px",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "4px",
  padding: "8px",
  color: "#cbd5e1",
  maxHeight: "220px",
  overflowY: "auto",
  margin: 0,
};
const STATUS_COLORS: Record<string, string> = { SUCCEEDED: "#4ade80", PENDING: "#facc15", FAILED: "#f87171" };
const STATUS_LABELS: Record<string, string> = { SUCCEEDED: "Delivered", PENDING: "Waiting to retry", FAILED: "Gave up" };
const EMPTY_FORM: FormState = { id: null, name: "", url: "", format: "json", events: ["run.closed", "results.failed"] };

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A pill that's on or off, as elsewhere in the Admin Panel. */
function Pill({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        padding: "3px 10px",
        borderRadius: "999px",
        border: `1px solid ${on ? "#0ea5e9" : "#334155"}`,
        backgroundColor: on ? "rgba(14, 165, 233, 0.18)" : "transparent",
        color: on ? "#7dd3fc" : "#94a3b8",
        fontSize: "11px",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function WebhooksPanel({ projects }: { projects: ProjectOption[] }) {
  const manageable = projects.filter((p) => !p.permissions || p.permissions.includes("WEBHOOK_MANAGE") || p.permissions.includes("SYSTEM_ADMIN"));
  const [projectId, setProjectId] = useState<string>(manageable[0]?.id ?? "");
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "rotate" | "delete"; webhook: Webhook } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [logFor, setLogFor] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<DeliverySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [opened, setOpened] = useState<Delivery | null>(null);
  const listSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const logSeq = useRef(0);

  // A new secret, a message or the form shows at the top: bring it into view.
  const formOpen = form !== null;
  useEffect(() => {
    if (secret || notice || formOpen) scroller.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [secret, notice, formOpen]);

  useEffect(() => {
    if (!projectId && manageable[0]) setProjectId(manageable[0].id);
  }, [manageable, projectId]);

  useEffect(() => {
    fetch(api.webhookEvents, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setEvents(d.events));
  }, []);

  const flash = (ok: boolean, text: string) => {
    setNotice({ ok, text });
    if (ok) setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 3500);
  };

  const loadWebhooks = useCallback(async () => {
    const seq = ++listSeq.current;
    if (!projectId) {
      setWebhooks([]);
      return;
    }
    const res = await fetch(api.projectWebhooks(projectId), { headers: authHeaders() });
    const d = await res.json().catch(() => ({}));
    if (seq !== listSeq.current) return;
    if (!res.ok) {
      setWebhooks([]);
      flash(false, errorMessage(d) || `Couldn't load webhooks (${res.status})`);
      return;
    }
    setWebhooks(d.webhooks);
  }, [projectId]);

  const loadDeliveries = useCallback(async (hook: Webhook, cursor: string | null = null) => {
    const seq = ++logSeq.current;
    const res = await fetch(api.webhookDeliveries(hook.id, { cursor, limit: 25 }), { headers: authHeaders() });
    const d = await res.json().catch(() => ({}));
    if (seq !== logSeq.current || !res.ok) return;
    setDeliveries((prev) => (cursor ? [...prev, ...d.deliveries] : d.deliveries));
    setNextCursor(d.next_cursor);
  }, []);

  useEffect(() => {
    // A new project: nothing from the old one stays on screen.
    setForm(null);
    setSecret(null);
    setConfirm(null);
    setLogFor(null);
    setDeliveries([]);
    setOpened(null);
    loadWebhooks();
  }, [loadWebhooks]);

  /** Sends a request; returns the body on success, or null after showing the error. */
  const send = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method, headers: body === undefined ? authHeaders() : jsonHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
      const d = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) {
        flash(false, errorMessage(d) || `Failed (${res.status})`);
        return null;
      }
      return d;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!form) return;
    const body = { name: form.name, url: form.url, format: form.format, events: form.events };
    const d = form.id ? await send(api.webhook(form.id), "PATCH", body) : await send(api.projectWebhooks(projectId), "POST", body);
    if (!d) return;
    if (!form.id) setSecret({ name: d.webhook.name, secret: d.secret });
    flash(true, form.id ? `✓ Webhook "${d.webhook.name}" saved.` : `✓ Webhook "${d.webhook.name}" created.`);
    setForm(null);
    loadWebhooks();
  };

  const toggleEnabled = async (hook: Webhook) => {
    if (await send(api.webhook(hook.id), "PATCH", { enabled: !hook.enabled })) loadWebhooks();
  };

  const ping = async (hook: Webhook) => {
    const d = await send(api.webhookPing(hook.id), "POST");
    if (!d) return;
    const delivery: Delivery = d.delivery;
    if (delivery.status === "SUCCEEDED") flash(true, `✓ Test event delivered to ${host(hook.url)} (HTTP ${delivery.response_status}, ${delivery.duration_ms} ms).`);
    else flash(false, `The test event wasn't delivered: ${delivery.error ?? `HTTP ${delivery.response_status}`}. It will be retried.`);
    loadWebhooks();
    if (logFor?.id === hook.id) loadDeliveries(hook);
  };

  const confirmAction = async () => {
    if (!confirm) return;
    const { kind, webhook } = confirm;
    setConfirm(null);
    if (kind === "rotate") {
      const d = await send(api.webhookRotateSecret(webhook.id), "POST");
      if (d) setSecret({ name: webhook.name, secret: d.secret });
    } else if (await send(api.webhook(webhook.id), "DELETE")) {
      flash(true, `✓ Webhook "${webhook.name}" deleted.`);
      if (logFor?.id === webhook.id) setLogFor(null);
    }
    loadWebhooks();
  };

  const openLog = (hook: Webhook) => {
    setLogFor(hook);
    setOpened(null);
    setDeliveries([]);
    loadDeliveries(hook);
  };

  const openDelivery = async (id: string) => {
    if (opened?.id === id) return setOpened(null);
    const res = await fetch(api.webhookDelivery(id), { headers: authHeaders() });
    if (res.ok) setOpened((await res.json()).delivery);
  };

  const redeliver = async (delivery: Delivery) => {
    const d = await send(api.webhookRedeliver(delivery.id), "POST");
    if (!d) return;
    flash(d.delivery.status === "SUCCEEDED", d.delivery.status === "SUCCEEDED" ? "✓ Sent again." : `Not delivered: ${d.delivery.error ?? `HTTP ${d.delivery.response_status}`}.`);
    if (logFor) loadDeliveries(logFor);
    loadWebhooks();
  };

  const copySecret = async () => {
    if (!secret) return;
    await navigator.clipboard?.writeText(secret.secret).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const groups = [...new Set(events.map((e) => e.group))];

  if (manageable.length === 0) {
    return <div style={{ fontSize: "13px", color: "#64748b" }}>You don't manage webhooks in any project (that needs WEBHOOK_MANAGE).</div>;
  }

  return (
    <div ref={scroller} style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1, overflowY: "auto", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>PROJECT</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
          {manageable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {!form && (
          <button onClick={() => setForm({ ...EMPTY_FORM })} style={primaryButton} disabled={busy}>
            + New webhook
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: "11px", color: "#64748b" }}>
        Webhooks send this project's events to other systems as they happen: a Slack channel, CI, a bug tracker or your own code. Each delivery is signed;
        failed ones are retried for about 11 hours.
      </p>

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

      {secret && (
        <div style={{ padding: "12px", backgroundColor: "rgba(34, 197, 94, 0.1)", border: "1px solid #22c55e", borderRadius: "6px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#4ade80", marginBottom: "6px" }}>Signing secret for "{secret.name}"</div>
          <div style={{ fontSize: "11px", color: "#fca5a5", marginBottom: "8px" }}>
            Copy it now: it won't be shown again. Your receiver uses it to check each delivery's X-Signature-SHA256 (not needed for Slack).
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <code style={{ ...codeBox, flex: 1, whiteSpace: "nowrap", overflowX: "auto", padding: "8px 10px", fontSize: "12px" }}>{secret.secret}</code>
            <button onClick={copySecret} style={{ ...primaryButton, backgroundColor: "#16a34a" }}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button onClick={() => setSecret(null)} style={buttonStyle}>
              Dismiss
            </button>
          </div>
        </div>
      )}


      {form && (
        <section style={{ backgroundColor: "#111827", border: "1px solid #1f2937", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "14px", color: "#e2e8f0" }}>{form.id ? "Edit webhook" : "New webhook"}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>NAME</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="QA channel" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>URL</label>
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>FORMAT</label>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
              <Pill on={form.format === "slack"} onClick={() => setForm({ ...form, format: "slack" })} title="Slack, Mattermost, Rocket.Chat, Discord (/slack URL)">
                Chat message (Slack-style)
              </Pill>
              <Pill on={form.format === "json"} onClick={() => setForm({ ...form, format: "json" })} title="The signed event, for CI, bug trackers or your own code">
                JSON event
              </Pill>
            </div>
          </div>
          <div>
            <label style={labelStyle}>EVENTS</label>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {groups.map((g) => (
                <div key={g} style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: "11px", color: "#64748b", width: "72px" }}>{g}</span>
                  {events
                    .filter((e) => e.group === g)
                    .map((e) => {
                      const on = form.events.includes(e.key);
                      return (
                        <Pill
                          key={e.key}
                          on={on}
                          title={e.description}
                          onClick={() => setForm({ ...form, events: on ? form.events.filter((x) => x !== e.key) : [...form.events, e.key] })}
                        >
                          {e.key}
                        </Pill>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={save} style={primaryButton} disabled={busy || !form.name.trim() || !form.url.trim() || form.events.length === 0}>
              {busy ? "Saving…" : form.id ? "Save" : "Create"}
            </button>
            <button onClick={() => setForm(null)} style={buttonStyle}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {webhooks.length === 0 && !form && <div style={{ fontSize: "13px", color: "#64748b" }}>No webhooks in this project yet.</div>}
        {webhooks.map((w) => (
          <div key={w.id} style={{ padding: "10px 12px", backgroundColor: "#0f172a", border: `1px solid ${logFor?.id === w.id ? "#0ea5e9" : "#334155"}`, borderRadius: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", opacity: w.enabled ? 1 : 0.6 }}>
              <div style={{ flex: 1, minWidth: "180px" }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#e2e8f0" }}>
                  {w.name}{" "}
                  <span style={{ fontSize: "10px", fontWeight: 600, color: "#94a3b8", border: "1px solid #334155", borderRadius: "3px", padding: "0 4px", marginLeft: "4px" }}>
                    {w.format === "slack" ? "CHAT" : "JSON"}
                  </span>
                </div>
                <div style={{ fontSize: "11px", color: "#94a3b8", overflowWrap: "anywhere" }}>
                  {host(w.url)} · {w.events.length} event{w.events.length === 1 ? "" : "s"}
                  {w.secret_hint && <span> · secret …{w.secret_hint}</span>}
                </div>
                <div style={{ fontSize: "11px", marginTop: "2px" }}>
                  {w.last_delivery ? (
                    <span style={{ color: STATUS_COLORS[w.last_delivery.status] }}>
                      ● {STATUS_LABELS[w.last_delivery.status]}: {w.last_delivery.event}, {new Date(w.last_delivery.created_at).toLocaleString()}
                      {w.last_delivery.error ? ` (${w.last_delivery.error})` : ""}
                    </span>
                  ) : (
                    <span style={{ color: "#64748b" }}>Nothing sent yet</span>
                  )}
                </div>
              </div>
              <Pill on={w.enabled} onClick={() => toggleEnabled(w)} title={w.enabled ? "Sending events; click to pause" : "Paused; click to send events again"}>
                {w.enabled ? "On" : "Off"}
              </Pill>
              <button onClick={() => ping(w)} style={smallButton} disabled={busy || !w.enabled} title="Send a ping event now">
                Send test
              </button>
              <button onClick={() => (logFor?.id === w.id ? setLogFor(null) : openLog(w))} style={smallButton}>
                {logFor?.id === w.id ? "Hide deliveries" : "Deliveries"}
              </button>
              <button onClick={() => setForm({ id: w.id, name: w.name, url: w.url, format: w.format, events: [...w.events] })} style={smallButton} disabled={busy}>
                Edit
              </button>
              <button onClick={() => setConfirm({ kind: "rotate", webhook: w })} style={smallButton} disabled={busy}>
                New secret
              </button>
              <button onClick={() => setConfirm({ kind: "delete", webhook: w })} style={{ ...smallButton, color: "#fca5a5", borderColor: "#7f1d1d" }} disabled={busy}>
                Delete
              </button>
            </div>

            {confirm?.webhook.id === w.id && (
              <div style={{ ...amberBanner, marginTop: "8px" }}>
                <span style={{ flex: 1, minWidth: "200px" }}>
                  {confirm.kind === "rotate"
                    ? `⚠️ Replace the signing secret of "${confirm.webhook.name}"? The old one stops working at once, so update the receiver with the new one.`
                    : `⚠️ Delete "${confirm.webhook.name}" and its delivery log? Events stop going to ${host(confirm.webhook.url)}.`}
                </span>
                <button onClick={confirmAction} style={{ ...buttonStyle, backgroundColor: "#b45309", border: "none", color: "#fff" }} disabled={busy}>
                  {confirm.kind === "rotate" ? "Replace secret" : "Delete Anyway"}
                </button>
                <button onClick={() => setConfirm(null)} style={buttonStyle}>
                  Cancel
                </button>
              </div>
            )}

            {logFor?.id === w.id && (
              <div style={{ marginTop: "10px", borderTop: "1px solid #1e293b", paddingTop: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700, flex: 1 }}>DELIVERIES (last 30 days)</span>
                  <button onClick={() => loadDeliveries(w)} style={smallButton}>
                    Refresh
                  </button>
                </div>
                {deliveries.length === 0 ? (
                  <div style={{ fontSize: "12px", color: "#64748b" }}>No deliveries yet.</div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                    <thead>
                      <tr style={{ color: "#64748b", textAlign: "left" }}>
                        <th style={{ padding: "4px" }}>When</th>
                        <th style={{ padding: "4px" }}>Event</th>
                        <th style={{ padding: "4px" }}>Status</th>
                        <th style={{ padding: "4px" }}>Tries</th>
                        <th style={{ padding: "4px" }}>Answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <React.Fragment key={d.id}>
                          <tr onClick={() => openDelivery(d.id)} style={{ borderTop: "1px solid #1e293b", cursor: "pointer", backgroundColor: opened?.id === d.id ? "#1e293b" : "transparent" }}>
                            <td style={{ padding: "4px", color: "#94a3b8", whiteSpace: "nowrap" }}>{new Date(d.created_at).toLocaleString()}</td>
                            <td style={{ padding: "4px", color: "#e2e8f0" }}>{d.event}</td>
                            <td style={{ padding: "4px", color: STATUS_COLORS[d.status], whiteSpace: "nowrap" }}>
                              {STATUS_LABELS[d.status]}
                              {d.status === "PENDING" && d.attempts > 0 && <span style={{ color: "#64748b" }}> · next {new Date(d.next_attempt_at).toLocaleTimeString()}</span>}
                            </td>
                            <td style={{ padding: "4px", color: "#94a3b8" }}>{d.attempts}</td>
                            <td style={{ padding: "4px", color: "#94a3b8", overflowWrap: "anywhere" }}>
                              {d.response_status ? `HTTP ${d.response_status}` : ""}
                              {d.error && d.status !== "SUCCEEDED" && d.error !== `HTTP ${d.response_status}` ? ` ${d.error}` : ""}
                              {d.duration_ms != null ? ` · ${d.duration_ms} ms` : ""}
                            </td>
                          </tr>
                          {opened?.id === d.id && (
                            <tr>
                              <td colSpan={5} style={{ padding: "6px 4px 10px" }}>
                                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "8px" }}>
                                  <div>
                                    <div style={{ ...labelStyle, fontSize: "10px" }}>SENT</div>
                                    <pre style={codeBox}>{JSON.stringify(opened.payload, null, 2)}</pre>
                                  </div>
                                  <div>
                                    <div style={{ ...labelStyle, fontSize: "10px" }}>ANSWER</div>
                                    <pre style={codeBox}>{opened.response_body || opened.error || "(nothing)"}</pre>
                                  </div>
                                </div>
                                <button onClick={() => redeliver(opened)} style={{ ...smallButton, marginTop: "6px" }} disabled={busy || !w.enabled}>
                                  Send again
                                </button>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
                {nextCursor && (
                  <button onClick={() => loadDeliveries(w, nextCursor)} style={{ ...smallButton, marginTop: "6px" }}>
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
