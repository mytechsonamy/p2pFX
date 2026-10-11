import type { BankConfig, LpMarketConfig } from './config.js';

type TradingHours = BankConfig['tradingHours'];

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday, 1 = Monday ... 7 = Sunday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, tz: string): LocalParts & { second: number } {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at local wall-clock time y-m-d hh:mm in `tz`. Handles 24:00 as next midnight. */
export function zonedTime(year: number, month: number, day: number, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hh, mm);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (p: { year: number; month: number; day: number }) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;

function isTradingDay(p: LocalParts, hours: TradingHours) {
  return hours.days.includes(p.weekday) && !hours.holidays.includes(isoDate(p));
}

/** Session open and close instants for the local calendar day containing `date`. */
function sessionFor(date: Date, hours: TradingHours) {
  const p = localParts(date, hours.timezone);
  return {
    trading: isTradingDay(p, hours),
    open: zonedTime(p.year, p.month, p.day, hours.open, hours.timezone),
    close: zonedTime(p.year, p.month, p.day, hours.close, hours.timezone),
  };
}

export function isMarketOpen(now: Date, hours: TradingHours): boolean {
  const s = sessionFor(now, hours);
  return s.trading && now >= s.open && now < s.close;
}

/**
 * End of the current trading session, or of the next one if the market is closed now.
 * Used as the expiry of DAY orders.
 */
export function currentOrNextSessionClose(now: Date, hours: TradingHours): Date {
  for (let i = 0; i < 30; i++) {
    const probe = new Date(now.getTime() + i * 86_400_000);
    const s = sessionFor(probe, hours);
    if (s.trading && s.close > now) return s.close;
  }
  throw new Error('no trading session in the next 30 days');
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Whether the LP market is open at `now` for an instrument kind (see `dealing.lpMarket`). */
export function isLpMarketOpen(now: Date, m: LpMarketConfig, kind: 'fx' | 'metal'): boolean {
  if (!m.enabled) return true;
  const p = localParts(now, m.timezone);
  if (m.holidays.includes(isoDate(p))) return false;
  const minute = p.hour * 60 + p.minute;
  // Minutes from Monday 00:00 local.
  const ofWeek = (day: number, t: number) => (day - 1) * 1440 + t;
  const at = ofWeek(p.weekday, minute);
  const open = ofWeek(m.weekOpen.day, toMinutes(m.weekOpen.time));
  const close = ofWeek(m.weekClose.day, toMinutes(m.weekClose.time));
  const weekClosed = close < open ? at >= close && at < open : at >= close || at < open;
  if (weekClosed) return false;
  const brk = m.dailyBreaks[kind];
  if (brk) {
    const [from, to] = [toMinutes(brk.from), toMinutes(brk.to)];
    if (from < to ? minute >= from && minute < to : minute >= from || minute < to) return false;
  }
  return true;
}

/**
 * The next instant the LP market opens after `now` (to the minute), or undefined if it opens within no 10 days.
 * Scans in 15-minute steps, then to the minute.
 */
export function nextLpMarketOpen(now: Date, m: LpMarketConfig, kind: 'fx' | 'metal'): Date | undefined {
  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  const step = 15 * 60_000;
  for (let t = start; t <= start + 10 * 86_400_000; t += step) {
    if (!isLpMarketOpen(new Date(t), m, kind)) continue;
    let first = t;
    for (let u = Math.max(start, t - step + 60_000); u < t; u += 60_000) {
      if (isLpMarketOpen(new Date(u), m, kind)) {
        first = u;
        break;
      }
    }
    return new Date(first);
  }
  return undefined;
}
