type SearchableOption = { value: string; label: string; disabled?: boolean };
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

/** Accept an exact displayed label or stored value only when it identifies one enabled option. */
export function exactCustomSelectOption<T extends SearchableOption>(options: readonly T[], query: string): T | undefined {
  const normalized = normalize(query);
  if (!normalized) return undefined;
  let match: T | undefined;
  for (const option of options) {
    if (option.disabled || normalize(option.label) !== normalized && normalize(option.value) !== normalized) continue;
    if (match) return undefined;
    match = option;
  }
  return match;
}
