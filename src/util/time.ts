// Time helpers. Fax, portal and phone exports use payer-local wall time with no offset;
// FHIR uses UTC. Everything is converted to epoch ms before matching.

export const PAYER_TZ = 'America/New_York';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function wallParts(utcMs: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of tz from UTC at the given instant, in minutes (e.g. -240 for EDT). */
export function tzOffsetMinutes(utcMs: number, tz: string = PAYER_TZ): number {
  const p = wallParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time in tz to epoch ms. */
export function wallToUtc(y: number, mo: number, d: number, h = 0, mi = 0, tz: string = PAYER_TZ): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMinutes(guess, tz);
  let utc = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(utc, tz);
  if (off2 !== off1) utc = guess - off2 * 60000;
  return utc;
}

/** Calendar date (YYYY-MM-DD) of an instant in tz. */
export function localDate(utcMs: number, tz: string = PAYER_TZ): string {
  const p = wallParts(utcMs, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localYear(utcMs: number, tz: string = PAYER_TZ): number {
  return wallParts(utcMs, tz).year;
}

/** "MM/DD/YYYY HH:mm" in tz. */
export function formatWall(utcMs: number, tz: string = PAYER_TZ): string {
  const p = wallParts(utcMs, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${z(p.month)}/${z(p.day)}/${p.year} ${z(p.hour)}:${z(p.minute)}`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Parse a payer-local date/time written in any of the formats seen in the exports:
 * "03/14/2026 10:42", "2026-03-14 10:42", "Mar 14 2026 10:42", "14-MAR-2026 10:42".
 * Returns epoch ms or undefined.
 */
export function parseWall(text: string, tz: string = PAYER_TZ): number | undefined {
  const s = text.trim().toUpperCase().replace(/\s+/g, ' ');
  let y: number, mo: number, d: number;
  let rest = '';
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/))) {
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4];
  } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4];
  } else if ((m = s.match(/^([A-Z]{3})[A-Z]*\.? (\d{1,2}),? (\d{4})(.*)$/))) {
    mo = MONTHS.indexOf(m[1]) + 1;
    [d, y] = [Number(m[2]), Number(m[3])];
    rest = m[4];
  } else if ((m = s.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})(.*)$/))) {
    mo = MONTHS.indexOf(m[2]) + 1;
    [d, y] = [Number(m[1]), Number(m[3])];
    rest = m[4];
  } else return undefined;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
  let h = 0,
    mi = 0;
  const t = rest.match(/(\d{1,2}):(\d{2})/);
  if (t) {
    h = Number(t[1]);
    mi = Number(t[2]);
  }
  return wallToUtc(y, mo, d, h, mi, tz);
}

/** Parse a date-only value to YYYY-MM-DD (no timezone math). */
export function parseDateOnly(text: string): string | undefined {
  const ms = parseWall(text, 'UTC');
  if (ms === undefined) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}
