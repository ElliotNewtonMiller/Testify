/**
 * When a scheduled report email is next due. Times are wall-clock times in the schedule's
 * own IANA time zone, so "Monday 09:00 America/New_York" stays 09:00 across DST changes.
 * Uses only Intl -- no time-zone library.
 */

export interface ScheduleTiming {
  frequency: 'DAILY' | 'WEEKLY';
  /** 0 = Sunday ... 6 = Saturday. WEEKLY only. */
  weekday: number | null;
  /** HH:MM, 24-hour. */
  time_of_day: string;
  timezone: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Problems with a timing, by field name; empty when it's valid. */
export function validateScheduleTiming(t: Partial<ScheduleTiming>): Array<{ field: string; reason: string }> {
  const errors: Array<{ field: string; reason: string }> = [];
  if (t.frequency !== 'DAILY' && t.frequency !== 'WEEKLY') errors.push({ field: 'frequency', reason: 'must be DAILY or WEEKLY' });
  if (t.frequency === 'WEEKLY' && !(Number.isInteger(t.weekday) && (t.weekday as number) >= 0 && (t.weekday as number) <= 6)) {
    errors.push({ field: 'weekday', reason: 'must be 0 (Sunday) to 6 (Saturday) for a weekly schedule' });
  }
  if (typeof t.time_of_day !== 'string' || !TIME_RE.test(t.time_of_day)) errors.push({ field: 'time_of_day', reason: 'must be HH:MM (24-hour)' });
  if (typeof t.timezone !== 'string' || !isValidTimeZone(t.timezone)) errors.push({ field: 'timezone', reason: 'must be an IANA time zone such as Europe/London' });
  return errors;
}

/** The zone's offset from UTC at `instant`, in ms (local minus UTC). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in a zone. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, hh, mm);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // Re-check at the result: near a DST change the offset at `guess` can differ.
  return guess - zoneOffsetMs(first, timeZone);
}

/** The local calendar date (and weekday) of an instant in a zone. */
function zonedDate(instant: number, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month') - 1, d: get('day') };
}

/** The first send time strictly after `after`. */
export function nextRunAt(t: ScheduleTiming, after: Date): Date {
  const [hh, mm] = t.time_of_day.split(':').map(Number);
  const today = zonedDate(after.getTime(), t.timezone);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(today.y, today.m, today.d + offset));
    if (t.frequency === 'WEEKLY' && day.getUTCDay() !== t.weekday) continue;
    const candidate = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm, t.timezone);
    if (candidate > after.getTime()) return new Date(candidate);
  }
  throw new Error('No next run found'); // unreachable for valid timings
}
