const DAY_MS = 86_400_000;

function calendarDate(year: number, month: number, day: number) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error("Некорректная календарная дата. Проверьте день, месяц и год.");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Read the date written in the workbook, without converting it to a local timezone. */
export function parsePersonnelImportDate(value: string | number, { date1904 = false }: { date1904?: boolean } = {}): string {
  const text = String(value).trim();
  if (!text) throw new Error("Не заполнена дата. Укажите дату в каждой заполненной строке отчёта.");

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-](\d{2}):?(\d{2}))?)?$/);
  if (iso) {
    if (iso[4] !== undefined && (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59 || Number(iso[7] ?? 0) > 23 || Number(iso[8] ?? 0) > 59)) throw new Error("Некорректное время в дате ISO.");
    return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  // Slash-separated dates always use day/month/year, never an inferred US locale.
  const local = text.match(/^(\d{1,2})([./])(\d{1,2})\2(\d{4})$/);
  if (local) return calendarDate(Number(local[4]), Number(local[3]), Number(local[1]));

  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    const serial = Number(text);
    if (!Number.isFinite(serial) || serial < (date1904 ? 0 : 1)) throw new Error("Некорректное числовое значение даты Excel.");
    const day = Math.floor(serial);
    // Excel's 1900 system contains a fictitious leap day, which has no valid ISO date.
    if (!date1904 && day === 60) throw new Error("Дата 29.02.1900 в Excel не существует в календаре.");
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(base + (date1904 ? day : day - (day > 60 ? 1 : 0)) * DAY_MS);
    if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() > 9999) throw new Error("Дата Excel выходит за допустимый календарный диапазон.");
    return calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  throw new Error("Не удалось распознать дату. Используйте дату Excel, ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.");
}
