export const SETTINGS_EXCEL_HEADERS = {
  employees: ["ФИО", "Тип", "Отдел", "Должность", "Проект"],
  positions: ["Тип", "Отдел", "Должность"],
  projectEmployees: ["ФИО"],
  zone: ["Зона"],
  master: ["ФИО"],
};

export const blankExcelRows = (columns: number) => Array.from({ length: 25 }, () => Array.from({ length: columns }, () => ""));
const key = (name: string) => name.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

/** Names in legacy workbooks must identify exactly one active employee. */
export function employeesFromExcelNames<T extends { id: number; fullName: string }>(names: readonly string[], employees: readonly T[]): T[] {
  const byName = new Map<string, T[]>();
  for (const employee of employees) {
    const name = key(employee.fullName);
    byName.set(name, [...byName.get(name) ?? [], employee]);
  }
  const found = new Map<number, T>();
  for (const name of names) {
    const matches = byName.get(key(name)) ?? [];
    if (!matches.length) throw new Error(`Сотрудник «${name}» не найден в доступном справочнике.`);
    if (matches.length !== 1) throw new Error(`ФИО «${name}» относится к нескольким сотрудникам. Уточните записи в справочнике перед импортом.`);
    found.set(matches[0].id, matches[0]);
  }
  return [...found.values()];
}
