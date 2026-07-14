/** Time helpers. Storage timestamps are UTC ISO strings. Buckets use business TZ. */

const DEFAULT_TZ = "Asia/Shanghai";

export function nowIso(d = new Date()): string {
  return d.toISOString();
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Format a Date as YYYY-MM-DDTHH:00:00+00:00 style bucket key in business TZ wall-clock, stored as local-labeled UTC-naive string.
 *  We store bucket_start as `YYYY-MM-DDTHH:00:00` representing the business-timezone hour start (not absolute UTC).
 */
export function hourBucketStart(isoTimestamp: string, timeZone: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) {
    return hourBucketStart(nowIso(), timeZone);
  }
  const parts = getTzParts(d, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00`;
}

export function dayBucketStart(isoTimestamp: string, timeZone: string): string {
  const hour = hourBucketStart(isoTimestamp, timeZone);
  return `${hour.slice(0, 10)}T00:00:00`;
}

export function businessTodayRange(timeZone: string, now = new Date()): { start: string; end: string } {
  const parts = getTzParts(now, timeZone);
  const startLocal = `${parts.year}-${parts.month}-${parts.day}T00:00:00`;
  // end exclusive: tomorrow 00:00 business local label
  const tomorrow = new Date(now.getTime() + 36 * 3600 * 1000); // safe overshoot then re-read
  // Better: add 1 day via UTC millis of "now in tz" approximation using formatter offset
  const startMs = zonedLocalToUtcMs(parts.year, parts.month, parts.day, "00", "00", "00", timeZone);
  const endMs = startMs + 24 * 3600 * 1000;
  const endParts = getTzParts(new Date(endMs), timeZone);
  const endLocal = `${endParts.year}-${endParts.month}-${endParts.day}T00:00:00`;
  return { start: startLocal, end: endLocal };
}

export function rangeStartForPreset(
  range: string,
  timeZone: string,
  now = new Date(),
): { startBucket: string; endBucket: string; granularity: "hour" | "day" } {
  const today = businessTodayRange(timeZone, now);
  const endBucket = today.end;

  switch (range) {
    case "24h": {
      const start = new Date(now.getTime() - 24 * 3600 * 1000);
      return {
        startBucket: hourBucketStart(start.toISOString(), timeZone),
        endBucket: hourBucketStart(new Date(now.getTime() + 3600 * 1000).toISOString(), timeZone),
        granularity: "hour",
      };
    }
    case "7d": {
      const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      return {
        startBucket: dayBucketStart(start.toISOString(), timeZone),
        endBucket,
        granularity: "day",
      };
    }
    case "30d": {
      const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      return {
        startBucket: dayBucketStart(start.toISOString(), timeZone),
        endBucket,
        granularity: "day",
      };
    }
    case "today":
    default:
      return {
        startBucket: today.start,
        endBucket: today.end,
        granularity: "hour",
      };
  }
}

export function resolveTz(envTz?: string): string {
  return (envTz && envTz.trim()) || DEFAULT_TZ;
}

interface TzParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function getTzParts(date: Date, timeZone: string): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

/** Approximate: interpret wall-clock in TZ as UTC instant via iterative offset. */
function zonedLocalToUtcMs(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
  timeZone: string,
): number {
  const guess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const parts = getTzParts(new Date(guess), timeZone);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = asIfUtc - guess;
  return guess - offset;
}
