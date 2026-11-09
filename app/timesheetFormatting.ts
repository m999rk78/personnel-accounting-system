const hoursFormatter = new Intl.NumberFormat("ru-RU", { useGrouping: true, maximumFractionDigits: 20 });

/** Keep thousands together with a narrow, nonbreaking space. */
export function formatTimesheetHours(hours: number): string {
  return hoursFormatter.format(hours).replaceAll("\u00a0", "\u202f");
}
