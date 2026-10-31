const PROJECT_TIME_ZONE = "Europe/Moscow";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PROJECT_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
});
const clockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: PROJECT_TIME_ZONE,
  hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Calendar dates in reports always follow the project's clock, not the browser's zone. */
export function currentProjectDate(now = new Date()): string {
  const parts = Object.fromEntries(dateFormatter.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Check periodically, and schedule the midnight check immediately after the date changes. */
export function projectDayCheckDelay(now = new Date()): number {
  const parts = Object.fromEntries(clockFormatter.formatToParts(now).map(part => [part.type, part.value]));
  const elapsed = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return Math.min(60_000, 86_400_000 - elapsed + 25);
}
