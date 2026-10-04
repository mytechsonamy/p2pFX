/** Offset of `timeZone` from UTC at `at`, in minutes (e.g. +180 for Europe/Istanbul). */
function offsetMinutes(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Today's date (YYYY-MM-DD) in `timeZone`, plus `days`. */
export function localDate(timeZone: string, days = 0, now = new Date()) {
  const d = new Date(now.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 23:59:59 local time on `date` (YYYY-MM-DD) in `timeZone`, as an ISO timestamp with offset. */
export function endOfDay(date: string, timeZone: string) {
  const guess = new Date(`${date}T23:59:59Z`);
  const off = offsetMinutes(guess, timeZone);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${date}T23:59:59${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
