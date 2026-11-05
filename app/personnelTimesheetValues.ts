export const PERSONNEL_TIMESHEET_CODES = [
  { value: "В", label: "Выходные и праздничные дни" },
  { value: "Б", label: "По болезни" },
  { value: "МО", label: "Межвахтовый отдых" },
  { value: "ДО", label: "Отпуск без сохранения заработной платы" },
  { value: "ПЕ", label: "Сотрудник переводится на другое СМУ" },
  { value: "УВ", label: "Увольнение" },
  { value: "Д", label: "Дорога" },
  { value: "ПР", label: "Прогулы" },
  { value: "О", label: "Отпуск" },
  { value: "К", label: "Командировка" },
  { value: "Н", label: "Неявки" },
  { value: "ЛН", label: "Легализация неоплачиваемая" },
  { value: "ЛО", label: "Легализация оплачиваемая" },
] as const;

export type PersonnelTimesheetCode = typeof PERSONNEL_TIMESHEET_CODES[number]["value"];
const codeValues = new Set<string>(PERSONNEL_TIMESHEET_CODES.map(code => code.value));

function hourOption(hours: number) {
  const label = hours === 1 ? "1 час отработан" : `${hours} ${hours >= 2 && hours <= 4 ? "часа" : "часов"} отработано`;
  return { value: String(hours), label };
}

// Keep the order from the personnel timesheet reference for supported values.
export const PERSONNEL_TIMESHEET_OPTIONS = [
  ...[10, 9, 8].map(hourOption),
  ...PERSONNEL_TIMESHEET_CODES.slice(0, 11).map(code => ({ value: code.value, label: `${code.value} — ${code.label}` })),
  ...[7, 6, 5, 4, 3, 2, 1].map(hourOption),
  ...PERSONNEL_TIMESHEET_CODES.slice(11).map(code => ({ value: code.value, label: `${code.value} — ${code.label}` })),
];

export function isPersonnelTimesheetCode(value: string): value is PersonnelTimesheetCode {
  return codeValues.has(value);
}

export function isPersonnelTimesheetHours(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

export function isPersonnelTimesheetValue(value: string): boolean {
  return /^\d+$/.test(value) ? isPersonnelTimesheetHours(Number(value)) : isPersonnelTimesheetCode(value);
}
