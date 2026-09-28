"use client";

import { useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";

type TimesheetEmployee = {
  id: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
};

type TimesheetEntry = {
  employeeId: number;
  workDate: string;
  hours: number;
  masters: string;
  zones: string;
};

type TimesheetMark = {
  employeeId: number;
  workDate: string;
  hours: number | null;
  code: string | null;
  note: string;
  updatedBy: string;
};

type TimesheetPayload = {
  siteId: number;
  siteName: string;
  month: string;
  canEdit: boolean;
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  marks: TimesheetMark[];
  error?: string;
};

type EditorCell = { employeeId: number; workDate: string };

const MONTH_FORMATTER = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DATE_FORMATTER = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const TIMESHEET_CODES = [
  { value: "В", label: "Выходной" },
  { value: "ДО", label: "Дополнительный отпуск" },
  { value: "МО", label: "Межвахтовый отдых" },
  { value: "ПЕ", label: "ПЕ" },
  { value: "УВ", label: "УВ" },
  { value: "ПР", label: "Прогул" },
] as const;
const CODE_VALUES = new Set(TIMESHEET_CODES.map((code) => code.value));

function monthDate(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1));
}

function shiftMonth(month: string, amount: number) {
  const value = monthDate(month);
  value.setUTCMonth(value.getUTCMonth() + amount);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function dateForDay(month: string, day: number) {
  return `${month}-${String(day).padStart(2, "0")}`;
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

function monthLabel(month: string) {
  const value = MONTH_FORMATTER.format(monthDate(month));
  return value.charAt(0).toLocaleUpperCase("ru-RU") + value.slice(1);
}

function dateLabel(value: string) {
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`));
}

function cellKey(employeeId: number, workDate: string) {
  return `${employeeId}:${workDate}`;
}

function effectiveHours(entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  if (mark?.code) return 0;
  if (mark?.hours !== null && mark?.hours !== undefined) return Number(mark.hours);
  return Number(entry?.hours ?? 0);
}

function markValue(mark: TimesheetMark | undefined, entry: TimesheetEntry | undefined) {
  if (mark?.code) return mark.code;
  if (mark?.hours !== null && mark?.hours !== undefined) return String(mark.hours);
  return entry?.hours ? String(entry.hours) : "";
}

function isMismatch(entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  return Boolean(mark) && effectiveHours(entry, mark) !== Number(entry?.hours ?? 0);
}

function cellDetails(entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  const details: string[] = [];
  if (entry) details.push(`Отчёт рабочих: ${entry.hours} ч.`);
  if (entry?.masters) details.push(`Мастер: ${entry.masters}`);
  if (entry?.zones) details.push(`Зона: ${entry.zones}`);
  if (mark) details.push(`Табель: ${mark.code ?? `${mark.hours} ч.`}`);
  if (mark?.note) details.push(`Комментарий: ${mark.note}`);
  if (mark?.updatedBy) details.push(`Изменил: ${mark.updatedBy}`);
  if (isMismatch(entry, mark)) details.push("Есть расхождение с отчётом рабочих");
  return details.join("\n");
}

export function TimesheetView({ siteId, initialMonth, today }: { siteId: number; initialMonth: string; today: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [payload, setPayload] = useState<TimesheetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");
  const [editor, setEditor] = useState<EditorCell | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [savingMark, setSavingMark] = useState(false);
  const [editorError, setEditorError] = useState("");
  const currentMonth = today.slice(0, 7);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => {
      setLoading(true);
      setError("");
      setEditor(null);
      fetch(`/api/timesheet?siteId=${siteId}&month=${month}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (response.status === 401) {
            window.location.replace("/login");
            return null;
          }
          const result = await response.json() as TimesheetPayload;
          if (!response.ok) throw new Error(result.error ?? "Не удалось сформировать табель.");
          return result;
        })
        .then((result) => { if (result) setPayload(result); })
        .catch((loadError: unknown) => {
          if (loadError instanceof DOMException && loadError.name === "AbortError") return;
          setError(loadError instanceof Error ? loadError.message : "Не удалось сформировать табель.");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [month, reloadKey, siteId]);

  useEffect(() => {
    if (!editor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingMark) setEditor(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editor, savingMark]);

  const days = useMemo(() => Array.from({ length: daysInMonth(month) }, (_, index) => index + 1), [month]);
  const entriesByCell = useMemo(() => new Map((payload?.entries ?? []).map((entry) => [cellKey(entry.employeeId, entry.workDate), entry])), [payload?.entries]);
  const marksByCell = useMemo(() => new Map((payload?.marks ?? []).map((mark) => [cellKey(mark.employeeId, mark.workDate), mark])), [payload?.marks]);
  const employeeById = useMemo(() => new Map((payload?.employees ?? []).map((employee) => [employee.id, employee])), [payload?.employees]);
  const departments = useMemo(() => Array.from(new Set((payload?.employees ?? []).map((employee) => employee.department).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru")), [payload?.employees]);
  const visibleEmployees = useMemo(() => {
    const query = normalize(search);
    return (payload?.employees ?? []).filter((employee) => {
      if (department !== "all" && employee.department !== department) return false;
      if (!query) return true;
      return normalize([employee.fullName, employee.employmentType, employee.department, employee.position].join(" ")).includes(query);
    });
  }, [department, payload?.employees, search]);
  const visibleEmployeeIds = useMemo(() => new Set(visibleEmployees.map((employee) => employee.id)), [visibleEmployees]);
  const visibleEntries = useMemo(() => (payload?.entries ?? []).filter((entry) => visibleEmployeeIds.has(entry.employeeId)), [payload?.entries, visibleEmployeeIds]);

  const reconciliation = useMemo(() => {
    const rows = new Map<number, { timesheet: number; reports: number; hasMismatch: boolean }>();
    const daysWithValues = new Set<string>();
    let mismatchedCells = 0;
    for (const employee of visibleEmployees) {
      let timesheet = 0;
      let reports = 0;
      let hasMismatch = false;
      for (const day of days) {
        const workDate = dateForDay(month, day);
        const entry = entriesByCell.get(cellKey(employee.id, workDate));
        const mark = marksByCell.get(cellKey(employee.id, workDate));
        const cellTimesheet = effectiveHours(entry, mark);
        timesheet += cellTimesheet;
        reports += Number(entry?.hours ?? 0);
        if (entry || mark) daysWithValues.add(workDate);
        if (isMismatch(entry, mark)) {
          mismatchedCells += 1;
          hasMismatch = true;
        }
      }
      rows.set(employee.id, { timesheet, reports, hasMismatch });
    }
    const timesheet = Array.from(rows.values()).reduce((sum, row) => sum + row.timesheet, 0);
    const reports = Array.from(rows.values()).reduce((sum, row) => sum + row.reports, 0);
    return {
      rows,
      timesheet,
      reports,
      difference: timesheet - reports,
      mismatchEmployees: Array.from(rows.values()).filter((row) => row.hasMismatch).length,
      mismatchedCells,
      completedDays: daysWithValues.size,
    };
  }, [days, entriesByCell, marksByCell, month, visibleEmployees]);

  const dayTotals = useMemo(() => new Map(days.map((day) => {
    const workDate = dateForDay(month, day);
    let timesheet = 0;
    let reports = 0;
    for (const employee of visibleEmployees) {
      const entry = entriesByCell.get(cellKey(employee.id, workDate));
      const mark = marksByCell.get(cellKey(employee.id, workDate));
      timesheet += effectiveHours(entry, mark);
      reports += Number(entry?.hours ?? 0);
    }
    return [workDate, { timesheet, reports }];
  })), [days, entriesByCell, marksByCell, month, visibleEmployees]);

  const employeesWithReports = new Set(visibleEntries.map((entry) => entry.employeeId)).size;

  const editingEmployee = editor ? employeeById.get(editor.employeeId) : undefined;
  const editingEntry = editor ? entriesByCell.get(cellKey(editor.employeeId, editor.workDate)) : undefined;
  const editingMark = editor ? marksByCell.get(cellKey(editor.employeeId, editor.workDate)) : undefined;
  const valueIsValid = /^([1-9]|10)$/.test(draftValue) || CODE_VALUES.has(draftValue as typeof TIMESHEET_CODES[number]["value"]);

  function openEditor(employeeId: number, workDate: string) {
    if (!payload?.canEdit || workDate > today) return;
    const entry = entriesByCell.get(cellKey(employeeId, workDate));
    const mark = marksByCell.get(cellKey(employeeId, workDate));
    setEditor({ employeeId, workDate });
    setDraftValue(markValue(mark, entry));
    setDraftNote(mark?.note ?? "");
    setEditorError("");
  }

  async function saveMark(clear = false) {
    if (!editor || !payload || (!clear && !valueIsValid)) return;
    setSavingMark(true);
    setEditorError("");
    try {
      const response = await fetch("/api/timesheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: payload.siteId, employeeId: editor.employeeId, workDate: editor.workDate, value: clear ? "" : draftValue, note: draftNote }),
      });
      if (response.status === 401) {
        window.location.replace("/login");
        return;
      }
      const result = await response.json() as { mark?: TimesheetMark; deleted?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить отметку.");
      setPayload((current) => current ? {
        ...current,
        marks: [
          ...current.marks.filter((mark) => cellKey(mark.employeeId, mark.workDate) !== cellKey(editor.employeeId, editor.workDate)),
          ...(result.mark ? [result.mark] : []),
        ],
      } : current);
      setEditor(null);
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку.");
    } finally {
      setSavingMark(false);
    }
  }

  function showFirstMismatch() {
    const firstMismatch = document.querySelector<HTMLElement>(".timesheet-table td.mismatch");
    if (!firstMismatch) return;
    firstMismatch.focus({ preventScroll: true });
    firstMismatch.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }

  return <section className="timesheet-page" aria-label="Табель учёта рабочего времени">
    <div className="timesheet-toolbar">
      <div className="timesheet-month-control" aria-label="Выбор месяца">
        <button type="button" onClick={() => setMonth((value) => shiftMonth(value, -1))} aria-label="Предыдущий месяц">‹</button>
        <label>
          <span>Расчётный месяц</span>
          <input type="month" value={month} max={currentMonth} onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} />
        </label>
        <button type="button" onClick={() => setMonth((value) => shiftMonth(value, 1))} disabled={month >= currentMonth} aria-label="Следующий месяц">›</button>
      </div>
      <div className="timesheet-filters">
        <label className="timesheet-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти сотрудника…" aria-label="Поиск сотрудника в табеле" />
          {search && <button type="button" onClick={() => setSearch("")} aria-label="Очистить поиск">×</button>}
        </label>
        <CustomSelect
          value={department}
          onChange={setDepartment}
          ariaLabel="Фильтр по отделу"
          className="timesheet-department-filter"
          options={[{ value: "all", label: "Все отделы" }, ...departments.map((value) => ({ value, label: value }))]}
        />
      </div>
    </div>

    <div className="timesheet-overview timesheet-overview-expanded">
      <div><span>Месяц</span><strong>{monthLabel(month)}</strong></div>
      <div><span>Сотрудников</span><strong>{visibleEmployees.length}</strong></div>
      <div><span>С отчётами</span><strong>{employeesWithReports}</strong></div>
      <div><span>Заполнено дней</span><strong>{reconciliation.completedDays} из {days.length}</strong></div>
      <div className="timesheet-overview-accent"><span>Табель</span><strong>{reconciliation.timesheet} ч.</strong></div>
      <div><span>Отчёты рабочих</span><strong>{reconciliation.reports} ч.</strong></div>
      <div className={reconciliation.difference === 0 ? "timesheet-overview-ok" : "timesheet-overview-warning"}><span>Разница</span><strong>{reconciliation.difference > 0 ? "+" : ""}{reconciliation.difference} ч.</strong></div>
    </div>

    <div className="timesheet-legend" aria-label="Обозначения табеля">
      <span className="timesheet-legend-item"><i className="report" />Часы из отчёта</span>
      <span className="timesheet-legend-item"><i className="manual" />Ручная отметка</span>
      <span className="timesheet-legend-item"><i className="mismatch" />Расхождение</span>
      {TIMESHEET_CODES.map((code) => <span className="timesheet-code-key" key={code.value}><strong>{code.value}</strong>{code.label}</span>)}
      {payload?.canEdit && <span className="timesheet-edit-hint">Двойной клик — изменить ячейку</span>}
    </div>

    {!error && !loading && reconciliation.mismatchedCells > 0 && <section className="timesheet-mismatch-alert" role="alert" aria-label="Обнаружены расхождения в табеле">
      <span className="timesheet-mismatch-icon" aria-hidden="true">!</span>
      <div>
        <strong>Обнаружены расхождения</strong>
        <p>{reconciliation.mismatchEmployees} сотрудников, {reconciliation.mismatchedCells} ячеек отличаются от ежедневных отчётов.</p>
      </div>
      <button type="button" onClick={showFirstMismatch}>Посмотреть расхождения</button>
    </section>}

    {error && <div className="timesheet-state timesheet-state-error"><strong>Не удалось открыть табель</strong><span>{error}</span><button type="button" onClick={() => setReloadKey((value) => value + 1)}>Повторить</button></div>}
    {!error && <div className="timesheet-grid-shell timesheet-grid-shell-reconciled" aria-busy={loading}>
      {loading && <div className="timesheet-loading">Формируем табель…</div>}
      {!loading && visibleEmployees.length === 0 && <div className="timesheet-empty"><strong>Нет сотрудников для отображения</strong><span>Измените фильтр или выберите другой месяц.</span></div>}
      {!loading && visibleEmployees.length > 0 && <table className="timesheet-table">
        <thead>
          <tr>
            <th className="timesheet-sticky timesheet-number-column" rowSpan={2}>№</th>
            <th className="timesheet-sticky timesheet-type-column" rowSpan={2}>Тип</th>
            <th className="timesheet-sticky timesheet-department-column" rowSpan={2}>Отдел</th>
            <th className="timesheet-sticky timesheet-employee-column" rowSpan={2}>Сотрудник</th>
            <th className="timesheet-sticky timesheet-position-column" rowSpan={2}>Должность</th>
            <th colSpan={days.length}>Дни месяца</th>
            <th className="timesheet-total-column timesheet-tabell-total" rowSpan={2}>Табель</th>
            <th className="timesheet-total-column timesheet-report-total" rowSpan={2}>Отчёты</th>
            <th className="timesheet-total-column timesheet-difference-total" rowSpan={2}>Разница</th>
          </tr>
          <tr>
            {days.map((day) => {
              const workDate = dateForDay(month, day);
              const weekDay = WEEKDAY_FORMATTER.format(new Date(`${workDate}T00:00:00Z`)).replace(".", "");
              const dayOfWeek = new Date(`${workDate}T00:00:00Z`).getUTCDay();
              return <th key={workDate} className={[dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "", workDate === today ? "today" : "", workDate > today ? "future" : ""].filter(Boolean).join(" ")}><span>{day}</span><small>{weekDay}</small></th>;
            })}
          </tr>
        </thead>
        <tbody>
          {visibleEmployees.map((employee, employeeIndex) => {
            const totals = reconciliation.rows.get(employee.id) ?? { timesheet: 0, reports: 0, hasMismatch: false };
            const difference = totals.timesheet - totals.reports;
            return <tr key={employee.id} className={totals.hasMismatch ? "timesheet-row-mismatch" : ""}>
              <td className="timesheet-sticky timesheet-number-column">{employeeIndex + 1}</td>
              <td className="timesheet-sticky timesheet-type-column"><span className="timesheet-type-badge">{employee.employmentType || "—"}</span></td>
              <td className="timesheet-sticky timesheet-department-column">{employee.department || "—"}</td>
              <th scope="row" className="timesheet-sticky timesheet-employee-column" title={`${employee.fullName}\n${employee.position}`}><span>{employee.fullName}</span><small className="timesheet-employee-meta">{employee.position || "Должность не указана"}</small></th>
              <td className="timesheet-sticky timesheet-position-column" title={employee.position}>{employee.position || "—"}</td>
              {days.map((day) => {
                const workDate = dateForDay(month, day);
                const entry = entriesByCell.get(cellKey(employee.id, workDate));
                const mark = marksByCell.get(cellKey(employee.id, workDate));
                const dayOfWeek = new Date(`${workDate}T00:00:00Z`).getUTCDay();
                const display = mark?.code ?? mark?.hours ?? entry?.hours ?? "";
                const mismatch = isMismatch(entry, mark);
                return <td
                  key={workDate}
                  className={[
                    entry || mark ? "filled" : "",
                    mark ? "manual" : "",
                    mark?.code ? "coded" : "",
                    mismatch ? "mismatch" : "",
                    payload?.canEdit && workDate <= today ? "editable" : "",
                    dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "",
                    workDate === today ? "today" : "",
                    workDate > today ? "future" : "",
                  ].filter(Boolean).join(" ")}
                  title={cellDetails(entry, mark)}
                  tabIndex={mismatch ? -1 : undefined}
                  onDoubleClick={() => openEditor(employee.id, workDate)}
                >{display}</td>;
              })}
              <td className="timesheet-total-column timesheet-tabell-total">{totals.timesheet || "—"}</td>
              <td className="timesheet-total-column timesheet-report-total">{totals.reports || "—"}</td>
              <td className={`timesheet-total-column timesheet-difference-total ${difference ? "has-difference" : ""}`}>{difference > 0 ? "+" : ""}{difference || "—"}</td>
            </tr>;
          })}
        </tbody>
        <tfoot>
          <tr>
            <th className="timesheet-sticky timesheet-summary-label" colSpan={5}>Итого по дням</th>
            {days.map((day) => {
              const workDate = dateForDay(month, day);
              const totals = dayTotals.get(workDate);
              return <td key={workDate} title={totals && totals.timesheet !== totals.reports ? `Отчёты рабочих: ${totals.reports} ч.` : ""}>{totals?.timesheet || ""}</td>;
            })}
            <th className="timesheet-total-column timesheet-tabell-total">{reconciliation.timesheet}</th>
            <th className="timesheet-total-column timesheet-report-total">{reconciliation.reports}</th>
            <th className={`timesheet-total-column timesheet-difference-total ${reconciliation.difference ? "has-difference" : ""}`}>{reconciliation.difference > 0 ? "+" : ""}{reconciliation.difference}</th>
          </tr>
        </tfoot>
      </table>}
    </div>}

    <p className="timesheet-source-note"><span aria-hidden="true">i</span> По умолчанию часы берутся из сохранённых отчётов рабочих. Ручная отметка хранится отдельно, поэтому исходный отчёт не меняется, а расхождение остаётся видимым.</p>

    {editor && editingEmployee && <div className="timesheet-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !savingMark) setEditor(null); }}>
      <form className="timesheet-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="timesheet-editor-title" onSubmit={(event) => { event.preventDefault(); void saveMark(); }}>
        <div className="timesheet-editor-heading">
          <div className="timesheet-editor-date"><strong>{new Date(`${editor.workDate}T00:00:00Z`).getUTCDate()}</strong><span>{WEEKDAY_FORMATTER.format(new Date(`${editor.workDate}T00:00:00Z`)).replace(".", "")}</span></div>
          <div><span>Отметка табеля</span><h2 id="timesheet-editor-title">{editingEmployee.fullName}</h2><p>{dateLabel(editor.workDate)} · {editingEmployee.position || "Должность не указана"}</p></div>
          <button type="button" aria-label="Закрыть" disabled={savingMark} onClick={() => setEditor(null)}>×</button>
        </div>
        <div className="timesheet-editor-content">
          <div className="timesheet-editor-source">
            <div><span>Источник: отчёт рабочих</span><strong>{editingEntry ? `${editingEntry.hours} ч.` : "Нет записи"}</strong></div>
            <p>{editingEntry ? [editingEntry.masters && `Мастер: ${editingEntry.masters}`, editingEntry.zones && `Зона: ${editingEntry.zones}`].filter(Boolean).join(" · ") : "За этот день сотрудник отсутствует в ежедневном отчёте."}</p>
          </div>
          <fieldset className="timesheet-hours-field">
            <legend>Отработанные часы</legend>
            <div><input inputMode="numeric" min="1" max="10" type="number" value={/^\d+$/.test(draftValue) ? draftValue : ""} onChange={(event) => setDraftValue(event.target.value)} placeholder="1–10" /><span>часов</span></div>
            <div className="timesheet-hour-shortcuts"><button type="button" className={draftValue === "8" ? "selected" : ""} onClick={() => setDraftValue("8")}>8 часов</button><button type="button" className={draftValue === "10" ? "selected" : ""} onClick={() => setDraftValue("10")}>10 часов</button></div>
          </fieldset>
          <fieldset className="timesheet-code-field">
            <legend>Или табельный код</legend>
            <div>{TIMESHEET_CODES.map((code) => <button type="button" className={draftValue === code.value ? "selected" : ""} key={code.value} onClick={() => setDraftValue(code.value)}><strong>{code.value}</strong><span>{code.label}</span></button>)}</div>
          </fieldset>
          <label className="timesheet-note-field"><span>Комментарий <small>необязательно</small></span><textarea maxLength={300} value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder="Причина корректировки или пояснение" /></label>
          {editorError && <div className="timesheet-editor-error">{editorError}</div>}
        </div>
        <div className="timesheet-editor-actions">
          <div>{editingMark && <button type="button" className="timesheet-clear-mark" disabled={savingMark} onClick={() => void saveMark(true)}>Вернуть данные отчёта</button>}</div>
          <div><button type="button" disabled={savingMark} onClick={() => setEditor(null)}>Отмена</button><button type="submit" className="timesheet-save-mark" disabled={savingMark || !valueIsValid}>{savingMark ? "Сохраняем…" : "Сохранить отметку"}</button></div>
        </div>
      </form>
    </div>}
  </section>;
}
