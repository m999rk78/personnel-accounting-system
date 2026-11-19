/** Display only: keep full author names in report data, filters and history. */
export function formatReportAuthorName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  if (!name || name === "Не назначен") return name;
  const [surname, ...parts] = name.split(" ");
  if (!parts.length) return surname;
  const initials = parts.map(part => /^(?:\p{L}\.)+$/u.test(part)
    ? part.toLocaleUpperCase("ru-RU")
    : `${Array.from(part)[0].toLocaleUpperCase("ru-RU")}.`).join("");
  return `${surname} ${initials}`;
}
