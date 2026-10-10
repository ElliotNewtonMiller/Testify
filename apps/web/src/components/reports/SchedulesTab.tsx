import React from "react";
import { Empty, ErrorNote, InfoTip, Loading, Section, buttonStyle, fmtWhen, selectStyle } from "./shared";
import { authHeaders, jsonHeaders } from "../../utils/session";

type SectionKind = "overview" | "latest_run" | "test_health" | "plan_trend";

interface ScheduleSection {
  kind: SectionKind;
  plan_id?: string;
}

interface Schedule {
  id: string;
  name: string;
  sections: ScheduleSection[];
  recipients: string[];
  message: string | null;
  frequency: "DAILY" | "WEEKLY";
  weekday: number | null;
  time_of_day: string;
  timezone: string;
  only_when_new_run: boolean;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

const KIND_LABELS: Record<SectionKind, string> = {
  overview: "Project overview",
  latest_run: "Latest run summary",
  test_health: "Test health",
  plan_trend: "Plan trend",
};
const KIND_HINTS: Record<SectionKind, string> = {
  overview: "Every active plan's latest run, new failures and testing activity over the last 7 days.",
  latest_run: "The plan's newest run when the email goes out: pass rate, what changed since the run before, and failures with their errors.",
  test_health: "Flaky, always-failing, slowing and stale cases across the plan's last 10 runs.",
  plan_trend: "Pass rate and new failures for each of the plan's last 10 runs.",
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATUS_COLORS: Record<string, string> = { SENT: "#4ade80", CAPTURED: "#7dd3fc", FAILED: "#f87171", SKIPPED: "#94a3b8" };

async function api(method: string, url: string, body?: unknown) {
  // Content-Type only with a body: Fastify rejects an empty body declared as JSON.
  const headers = body !== undefined ? jsonHeaders() : authHeaders();
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.detail || data.error || `Request failed (${res.status})`);
  return data;
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

function describeWhen(s: Pick<Schedule, "frequency" | "weekday" | "time_of_day" | "timezone">) {
  return `${s.frequency === "DAILY" ? "Every day" : `Every ${WEEKDAYS[s.weekday ?? 1]}`} at ${s.time_of_day} (${s.timezone})`;
}

interface Draft {
  id: string | null;
  name: string;
  kinds: Record<SectionKind, boolean>;
  planId: string;
  recipients: string;
  message: string;
  frequency: "DAILY" | "WEEKLY";
  weekday: number;
  time_of_day: string;
  timezone: string;
  only_when_new_run: boolean;
  enabled: boolean;
}

function draftFrom(s: Schedule | null, defaultPlanId: string): Draft {
  if (!s) {
    return {
      id: null,
      name: "Weekly test report",
      kinds: { overview: true, latest_run: true, test_health: false, plan_trend: false },
      planId: defaultPlanId,
      recipients: "",
      message: "",
      frequency: "WEEKLY",
      weekday: 1,
      time_of_day: "09:00",
      timezone: browserTimeZone(),
      only_when_new_run: false,
      enabled: true,
    };
  }
  return {
    id: s.id,
    name: s.name,
    kinds: {
      overview: s.sections.some((x) => x.kind === "overview"),
      latest_run: s.sections.some((x) => x.kind === "latest_run"),
      test_health: s.sections.some((x) => x.kind === "test_health"),
      plan_trend: s.sections.some((x) => x.kind === "plan_trend"),
    },
    planId: s.sections.find((x) => x.plan_id)?.plan_id ?? defaultPlanId,
    recipients: s.recipients.join(", "),
    message: s.message ?? "",
    frequency: s.frequency,
    weekday: s.weekday ?? 1,
    time_of_day: s.time_of_day,
    timezone: s.timezone,
    only_when_new_run: s.only_when_new_run,
    enabled: s.enabled,
  };
}

const inputStyle: React.CSSProperties = { ...selectStyle, padding: "6px 8px", width: "100%", boxSizing: "border-box", fontFamily: "inherit" };
const labelStyle: React.CSSProperties = { fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 };

/** Report emails sent automatically on a schedule, for one project. */
export function SchedulesTab({ projectId, plans, defaultPlanId }: { projectId: string; plans: Array<{ id: string; name: string; status?: string }>; defaultPlanId: string }) {
  const [schedules, setSchedules] = React.useState<Schedule[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const base = `/api/v1/projects/${projectId}/report-schedules`;

  const load = React.useCallback(async () => {
    try {
      setSchedules((await api("GET", base)).schedules);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);
  React.useEffect(() => {
    setSchedules(null);
    setDraft(null);
    load();
  }, [load]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  };

  const toBody = (d: Draft) => ({
    name: d.name,
    sections: (Object.keys(d.kinds) as SectionKind[]).filter((k) => d.kinds[k]).map((k) => (k === "overview" ? { kind: k } : { kind: k, plan_id: d.planId })),
    recipients: d.recipients,
    message: d.message || null,
    frequency: d.frequency,
    weekday: d.frequency === "WEEKLY" ? d.weekday : null,
    time_of_day: d.time_of_day,
    timezone: d.timezone,
    only_when_new_run: d.only_when_new_run,
    enabled: d.enabled,
  });

  const save = async () => {
    if (!draft) return;
    setFormError(null);
    try {
      await api(draft.id ? "PUT" : "POST", draft.id ? `${base}/${draft.id}` : base, toBody(draft));
      setDraft(null);
      flash(draft.id ? "✓ Schedule saved." : "✓ Schedule created.");
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const act = async (s: Schedule, action: "toggle" | "send" | "delete") => {
    setBusyId(s.id);
    try {
      if (action === "delete") {
        await api("DELETE", `${base}/${s.id}`);
        flash(`Deleted "${s.name}".`);
      } else if (action === "toggle") {
        await api("PUT", `${base}/${s.id}`, toBody({ ...draftFrom(s, defaultPlanId), enabled: !s.enabled }));
      } else {
        const r = await api("POST", `${base}/${s.id}/send-now`);
        flash(
          r.status === "SENT"
            ? `✓ "${s.name}" sent.`
            : r.status === "CAPTURED"
              ? `✓ "${s.name}" captured, not sent -- no mail server is set up yet (Admin Panel → Email).`
              : r.status === "SKIPPED"
                ? `Skipped: ${r.error}`
                : `Sending failed: ${r.error}`
        );
      }
      load();
    } catch (e) {
      flash(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const needsPlan = draft && (draft.kinds.latest_run || draft.kinds.test_health || draft.kinds.plan_trend);
  // Every IANA zone the browser knows, grouped by region ("America", "Europe", ...). Falls
  // back to a short list on browsers without Intl.supportedValuesOf.
  const timeZoneGroups = React.useMemo(() => {
    let zones: string[] = [];
    try {
      zones = ((Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined) ?? [];
    } catch {
      zones = [];
    }
    if (zones.length === 0) {
      zones = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];
    }
    const groups = new Map<string, string[]>();
    for (const tz of zones) {
      if (tz === "UTC") continue; // offered at the top
      const region = tz.includes("/") ? tz.split("/")[0] : "Other";
      groups.set(region, [...(groups.get(region) ?? []), tz]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, []);
  const tzLabel = (tz: string) => tz.replace(/_/g, " ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Section
        title="Scheduled emails"
        info="Report emails sent automatically, daily or weekly, to any addresses -- recipients don't need a Testify account. The numbers are worked out when each email goes out."
        actions={
          !draft && (
            <button style={{ ...buttonStyle, backgroundColor: "#0284c7", border: "none", color: "#fff" }} onClick={() => setDraft(draftFrom(null, defaultPlanId || plans[0]?.id || ""))}>
              + New schedule
            </button>
          )
        }
      >
        {notice && <div style={{ fontSize: "12px", color: notice.startsWith("⚠️") || notice.startsWith("Sending failed") ? "#f87171" : "#86efac", marginBottom: 8, overflowWrap: "anywhere" }}>{notice}</div>}

        {draft && (
          <div style={{ border: "1px solid #334155", borderRadius: "6px", padding: "12px", marginBottom: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Name (the email's subject)</label>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} maxLength={255} />
            </div>
            <div>
              <span style={labelStyle}>Include</span>
              <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
                {(Object.keys(KIND_LABELS) as SectionKind[]).map((k) => (
                  <label key={k} style={{ fontSize: "12px", color: "#cbd5e1", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={draft.kinds[k]} onChange={(e) => setDraft({ ...draft, kinds: { ...draft.kinds, [k]: e.target.checked } })} />
                    <InfoTip text={KIND_HINTS[k]}>{KIND_LABELS[k]}</InfoTip>
                  </label>
                ))}
              </div>
            </div>
            {needsPlan && (
              <div style={{ maxWidth: 320 }}>
                <label style={labelStyle}>Test plan</label>
                <select value={draft.planId} onChange={(e) => setDraft({ ...draft, planId: e.target.value })} style={inputStyle}>
                  {!draft.planId && <option value="">Pick a plan…</option>}
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.status && p.status !== "ACTIVE" ? ` [${p.status}]` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label style={labelStyle}>How often</label>
                <select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Draft["frequency"] })} style={inputStyle}>
                  <option value="WEEKLY">Weekly</option>
                  <option value="DAILY">Daily</option>
                </select>
              </div>
              {draft.frequency === "WEEKLY" && (
                <div>
                  <label style={labelStyle}>On</label>
                  <select value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })} style={inputStyle}>
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label style={labelStyle}>At</label>
                <input type="time" value={draft.time_of_day} onChange={(e) => setDraft({ ...draft, time_of_day: e.target.value })} style={inputStyle} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={labelStyle}>Time zone</label>
                <select value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} style={inputStyle}>
                  <option value={browserTimeZone()}>Your time zone ({tzLabel(browserTimeZone())})</option>
                  {browserTimeZone() !== "UTC" && <option value="UTC">UTC</option>}
                  {/* A saved zone this browser doesn't list (e.g. renamed) still shows. */}
                  {draft.timezone !== browserTimeZone() && !timeZoneGroups.some(([, zones]) => zones.includes(draft.timezone)) && (
                    <option value={draft.timezone}>{tzLabel(draft.timezone)}</option>
                  )}
                  {timeZoneGroups.map(([region, zones]) => (
                    <optgroup key={region} label={region}>
                      {zones.map((tz) => (
                        <option key={tz} value={tz}>
                          {tzLabel(tz)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <textarea rows={2} value={draft.recipients} onChange={(e) => setDraft({ ...draft, recipients: e.target.value })} placeholder="stakeholder@example.com, qa-lead@example.com" style={{ ...inputStyle, resize: "vertical" }} />
            </div>
            <div>
              <label style={labelStyle}>Note (optional)</label>
              <textarea rows={2} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} maxLength={2000} style={{ ...inputStyle, resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <label style={{ fontSize: "12px", color: "#cbd5e1", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={draft.only_when_new_run} onChange={(e) => setDraft({ ...draft, only_when_new_run: e.target.checked })} disabled={!draft.kinds.latest_run} />
                <InfoTip text="Skip the email when the plan's latest run is the same one the previous email reported on. Needs 'Latest run summary'.">Only when there's a new run</InfoTip>
              </label>
              <label style={{ fontSize: "12px", color: "#cbd5e1", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                Enabled
              </label>
            </div>
            {formError && <ErrorNote message={formError} />}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button style={buttonStyle} onClick={() => { setDraft(null); setFormError(null); }}>
                Cancel
              </button>
              <button style={{ ...buttonStyle, backgroundColor: "#0284c7", border: "none", color: "#fff" }} onClick={save}>
                {draft.id ? "Save" : "Create schedule"}
              </button>
            </div>
          </div>
        )}

        {error ? (
          <ErrorNote message={error} />
        ) : !schedules ? (
          <Loading />
        ) : schedules.length === 0 && !draft ? (
          <Empty>No scheduled emails yet.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {schedules.map((s) => {
              const plan = plans.find((p) => p.id === s.sections.find((x) => x.plan_id)?.plan_id);
              return (
                <div key={s.id} style={{ backgroundColor: "#111827", border: "1px solid #1e293b", borderRadius: "6px", padding: "10px 12px", opacity: s.enabled ? 1 : 0.6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "#e2e8f0" }}>{s.name}</span>
                    {!s.enabled && <span style={{ fontSize: "10px", color: "#94a3b8", border: "1px solid #334155", borderRadius: 3, padding: "0 4px" }}>PAUSED</span>}
                    <span style={{ flex: 1 }} />
                    <button style={buttonStyle} disabled={busyId === s.id} onClick={() => act(s, "send")}>
                      Send now
                    </button>
                    <button style={buttonStyle} disabled={busyId === s.id} onClick={() => act(s, "toggle")}>
                      {s.enabled ? "Pause" : "Resume"}
                    </button>
                    <button style={buttonStyle} disabled={busyId === s.id} onClick={() => setDraft(draftFrom(s, defaultPlanId))}>
                      Edit
                    </button>
                    <button style={{ ...buttonStyle, color: "#f87171" }} disabled={busyId === s.id} onClick={() => act(s, "delete")}>
                      Delete
                    </button>
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: 4 }}>
                    {s.sections.map((x) => KIND_LABELS[x.kind]).join(" + ")}
                    {plan ? ` · plan ${plan.name}` : ""} · {describeWhen(s)} · {s.recipients.length} recipient{s.recipients.length === 1 ? "" : "s"}
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: 2, overflowWrap: "anywhere", minWidth: 0 }}>
                    {s.enabled && <>Next: {fmtWhen(s.next_run_at)}</>}
                    {s.last_run_at && (
                      <>
                        {s.enabled ? " · " : ""}Last: {fmtWhen(s.last_run_at)} <span style={{ color: STATUS_COLORS[s.last_status ?? ""] ?? "#94a3b8", fontWeight: 700 }}>{s.last_status === "CAPTURED" ? "captured" : s.last_status?.toLowerCase()}</span>
                        {s.last_error && <span style={{ color: s.last_status === "FAILED" ? "#fca5a5" : "#94a3b8" }}> — {s.last_error}</span>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
