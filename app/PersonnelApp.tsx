"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Option = { id: number; name: string };
type Site = Option & { code: string; timezone: string };
type Employee = { id: number; fullName: string; position: string; source: string };
type Entry = {
  id: number;
  siteId: number;
  workDate: string;
  employeeId: number;
  shiftId: number;
  zoneId: number;
  mainWorkTypeId: number;
  subworkTypeId: number;
  note: string;
  masterId: number;
  hours: number;
  positionSnapshot: string;
  employeeName: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  masterName: string;
};
type DataSet = {
  sites: Site[];
  employees: Employee[];
  shifts: Option[];
  zones: Option[];
  mainWorkTypes: Option[];
  subworkTypes: Option[];
  masters: Option[];
  entries: Entry[];
};
type Draft = {
  employeeId: string;
  shiftId: string;
  zoneId: string;
  mainWorkTypeId: string;
  subworkTypeId: string;
  note: string;
  masterId: string;
  hours: string;
};

const emptyDraft: Draft = { employeeId: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", note: "", masterId: "", hours: "" };
const today = new Date().toLocaleDateString("en-CA");

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function SelectField({ label, value, options, onChange, wide = false }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; wide?: boolean }) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Выберите</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </label>
  );
}

export default function PersonnelApp() {
  const [role, setRole] = useState<"foreman" | "office">("foreman");
  const [view, setView] = useState<"placement" | "employees" | "directories">("placement");
  const [siteId, setSiteId] = useState(1);
  const [workDate, setWorkDate] = useState(today);
  const [data, setData] = useState<DataSet | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftOpen, setDraftOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}`, { cache: "no-store" });
      const payload = await response.json() as DataSet & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить данные.");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить данные.");
    } finally {
      setLoading(false);
    }
  }, [siteId, workDate]);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => {
    if (role === "foreman") {
      setSiteId(1);
      setWorkDate(today);
    }
  }, [role]);

  const selectedEmployee = data?.employees.find((employee) => employee.id === Number(draft.employeeId));
  const filteredEntries = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return data?.entries ?? [];
    return (data?.entries ?? []).filter((entry) => [entry.employeeName, entry.zoneName, entry.mainWorkTypeName, entry.masterName].some((field) => field.toLowerCase().includes(value)));
  }, [data, search]);
  const totals = useMemo(() => ({
    people: new Set(filteredEntries.map((entry) => entry.employeeId)).size,
    rows: filteredEntries.length,
    hours: filteredEntries.reduce((sum, entry) => sum + entry.hours, 0),
  }), [filteredEntries]);

  function changeDraft(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError("");
  }

  function startAdd() {
    setDraft(emptyDraft);
    setEditingId(null);
    setDraftOpen(true);
    setNotice("");
  }

  function startEdit(entry: Entry) {
    setDraft({ employeeId: String(entry.employeeId), shiftId: String(entry.shiftId), zoneId: String(entry.zoneId), mainWorkTypeId: String(entry.mainWorkTypeId), subworkTypeId: String(entry.subworkTypeId), note: entry.note, masterId: String(entry.masterId), hours: String(entry.hours) });
    setEditingId(entry.id);
    setDraftOpen(true);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveDraft() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId ?? undefined, siteId, workDate, ...Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, key === "note" ? value : Number(value)])) }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось сохранить строку.");
      setDraftOpen(false);
      setDraft(emptyDraft);
      setEditingId(null);
      setNotice(editingId ? "Строка обновлена" : "Строка добавлена");
      await loadData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить строку.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(id: number) {
    if (!window.confirm("Удалить эту строку расстановки?")) return;
    setError("");
    const response = await fetch(`/api/data?id=${id}`, { method: "DELETE" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) setError(payload.error ?? "Не удалось удалить строку.");
    else {
      setNotice("Строка удалена");
      await loadData();
    }
  }

  function exportExcel() {
    if (!data) return;
    const site = data.sites.find((item) => item.id === siteId);
    const rows = filteredEntries.map((entry) => [entry.workDate, entry.employeeName, entry.shiftName, entry.zoneName, entry.mainWorkTypeName, entry.subworkTypeName, entry.note, entry.masterName, entry.hours, entry.positionSnapshot]);
    const escape = (value: string | number) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><h2>${escape(site?.name ?? "Объект")}</h2><table border="1"><tr>${["Дата", "ФИО", "Смена", "Зона", "Виды основных работ", "Виды подработ", "Примечание", "Мастер", "Часы", "Тип-2"].map((header) => `<th>${header}</th>`).join("")}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</table></body></html>`;
    const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Расстановка_${site?.code ?? siteId}_${workDate}.xls`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const navItems = [
    { id: "placement" as const, icon: "Р", label: "Расстановка" },
    { id: "employees" as const, icon: "С", label: "Сотрудники" },
    { id: "directories" as const, icon: "С", label: "Справочники" },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">УП</span><div><strong>Учёт персонала</strong><small>Строительные объекты</small></div></div>
        <nav aria-label="Основная навигация">
          <p className="nav-caption">РАБОЧАЯ ОБЛАСТЬ</p>
          {navItems.map((item) => <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => setView(item.id)}><span>{item.icon}</span>{item.label}</button>)}
          <p className="nav-caption second">УПРАВЛЕНИЕ</p>
          <button className="nav-item muted" disabled><span>П</span>Пользователи <em>скоро</em></button>
          <button className="nav-item muted" disabled><span>Ж</span>Журнал <em>скоро</em></button>
        </nav>
        <div className="sidebar-footer"><div className="avatar">МА</div><div><strong>Марк Аванесов</strong><small>{role === "foreman" ? "Прораб" : "Офис"}</small></div><button aria-label="Настройки пользователя">⋯</button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">УЧЁТ РАБОЧЕГО ВРЕМЕНИ</p><h1>{view === "placement" ? "Расстановка" : view === "employees" ? "Сотрудники" : "Справочники объекта"}</h1></div>
          <div className="top-actions"><div className="role-switch" aria-label="Демонстрационная роль"><button className={role === "foreman" ? "selected" : ""} onClick={() => setRole("foreman")}>Прораб</button><button className={role === "office" ? "selected" : ""} onClick={() => setRole("office")}>Офис</button></div><button className="help-button" aria-label="Помощь">?</button></div>
        </header>

        {view === "placement" && <>
          <section className="control-strip">
            <label><span>Объект</span><select value={siteId} onChange={(event) => setSiteId(Number(event.target.value))}>{(data?.sites ?? []).filter((_, index) => role === "office" || index === 0).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
            <label><span>Дата</span><input type="date" value={workDate} max={role === "foreman" ? today : undefined} disabled={role === "foreman"} onChange={(event) => setWorkDate(event.target.value)} /></label>
            <div className="date-label"><span>Рабочий день</span><strong>{formatDate(workDate)}</strong></div>
            <div className="control-actions"><button className="secondary-button" onClick={exportExcel} disabled={!filteredEntries.length}>⇩ Экспорт Excel</button><button className="primary-button" onClick={startAdd}>＋ Добавить строку</button></div>
          </section>

          {draftOpen && <section className="entry-editor">
            <div className="editor-heading"><div><span>{editingId ? "РЕДАКТИРОВАНИЕ" : "НОВАЯ СТРОКА"}</span><h2>{editingId ? "Измените данные сотрудника" : "Добавьте выполненную работу"}</h2></div><button onClick={() => setDraftOpen(false)} aria-label="Закрыть форму">×</button></div>
            <div className="editor-grid">
              <SelectField label="ФИО сотрудника *" value={draft.employeeId} options={(data?.employees ?? []).map(({ id, fullName }) => ({ id, name: fullName }))} onChange={(value) => changeDraft("employeeId", value)} wide />
              <SelectField label="Смена *" value={draft.shiftId} options={data?.shifts ?? []} onChange={(value) => changeDraft("shiftId", value)} />
              <SelectField label="Зона *" value={draft.zoneId} options={data?.zones ?? []} onChange={(value) => changeDraft("zoneId", value)} />
              <SelectField label="Основная работа *" value={draft.mainWorkTypeId} options={data?.mainWorkTypes ?? []} onChange={(value) => changeDraft("mainWorkTypeId", value)} wide />
              <SelectField label="Вид подработ *" value={draft.subworkTypeId} options={data?.subworkTypes ?? []} onChange={(value) => changeDraft("subworkTypeId", value)} wide />
              <SelectField label="Мастер *" value={draft.masterId} options={data?.masters ?? []} onChange={(value) => changeDraft("masterId", value)} wide />
              <label className="field"><span>Часы *</span><select value={draft.hours} onChange={(event) => changeDraft("hours", event.target.value)}><option value="">Выберите</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((hours) => <option key={hours} value={hours}>{hours}</option>)}</select></label>
              <label className="field wide"><span>Тип-2 · автоматически</span><input value={selectedEmployee?.position ?? "Выберите сотрудника"} disabled /></label>
              <label className="field note"><span>Примечание</span><input value={draft.note} placeholder="Необязательно" onChange={(event) => changeDraft("note", event.target.value)} /></label>
            </div>
            <div className="editor-footer"><p><span>i</span> Суммарно не более 10 часов на сотрудника в день</p><div><button className="text-button" onClick={() => setDraftOpen(false)}>Отмена</button><button className="primary-button" onClick={() => void saveDraft()} disabled={saving}>{saving ? "Сохраняем…" : editingId ? "Сохранить изменения" : "Добавить в расстановку"}</button></div></div>
          </section>}

          {error && <div className="message error"><strong>Не удалось выполнить действие</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          {notice && <div className="message success"><strong>Готово</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}

          <section className="metrics">
            <div><span className="metric-icon green">С</span><p>Сотрудников сегодня<strong>{totals.people}</strong></p></div>
            <div><span className="metric-icon blue">Ч</span><p>Всего часов<strong>{totals.hours}</strong></p></div>
            <div><span className="metric-icon orange">Р</span><p>Строк расстановки<strong>{totals.rows}</strong></p></div>
            <div className="metric-status"><span>●</span><p>Данные доступны офису<strong>Сохраняются сразу</strong></p></div>
          </section>

          <section className="table-card">
            <div className="table-toolbar"><div><h2>Расстановка на день</h2><p>{data?.sites.find((site) => site.id === siteId)?.name} · {formatDate(workDate)}</p></div><label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти сотрудника, зону или работу" /></label></div>
            <div className="table-wrap">
              <table><thead><tr><th>ФИО</th><th>Смена</th><th>Зона</th><th>Основная работа</th><th>Вид подработ</th><th>Мастер</th><th className="hours">Часы</th><th>Тип-2</th><th></th></tr></thead>
              <tbody>{loading ? <tr><td colSpan={9} className="empty-state">Загружаем расстановку…</td></tr> : filteredEntries.length === 0 ? <tr><td colSpan={9} className="empty-state"><strong>Записей пока нет</strong><span>Добавьте первую строку расстановки на этот день.</span></td></tr> : filteredEntries.map((entry) => <tr key={entry.id}><td><div className="employee-cell"><span>{entry.employeeName.split(" ").slice(0, 2).map((name) => name[0]).join("")}</span><div><strong>{entry.employeeName}</strong>{entry.note && <small>{entry.note}</small>}</div></div></td><td><span className={`shift ${entry.shiftName === "ночь" ? "night" : ""}`}>{entry.shiftName}</span></td><td>{entry.zoneName}</td><td>{entry.mainWorkTypeName}</td><td>{entry.subworkTypeName}</td><td>{entry.masterName}</td><td className="hours"><strong>{entry.hours}</strong></td><td><span className="position">{entry.positionSnapshot}</span></td><td><div className="row-actions"><button onClick={() => startEdit(entry)} aria-label={`Редактировать ${entry.employeeName}`}>✎</button><button onClick={() => void deleteEntry(entry.id)} aria-label={`Удалить ${entry.employeeName}`}>×</button></div></td></tr>)}</tbody></table>
            </div>
            <div className="table-footer"><span>Показано строк: {filteredEntries.length}</span><strong>Итого по фильтру: {totals.hours} ч.</strong></div>
          </section>
        </>}

        {view === "employees" && <section className="directory-page"><div className="section-intro"><div><h2>Общий справочник сотрудников</h2><p>В следующих версиях данные будут синхронизироваться с Bitrix24.</p></div><span className="integration-badge">Bitrix24 · запланировано</span></div><div className="employee-list">{(data?.employees ?? []).map((employee) => <article key={employee.id}><span>{employee.fullName.split(" ").slice(0, 2).map((name) => name[0]).join("")}</span><div><h3>{employee.fullName}</h3><p>{employee.position}</p></div><em>{employee.source === "excel" ? "Excel" : employee.source}</em></article>)}</div></section>}

        {view === "directories" && <section className="directory-page"><div className="section-intro"><div><h2>Справочники объекта</h2><p>{data?.sites.find((site) => site.id === siteId)?.name}. Значения других объектов сюда не попадают.</p></div><select value={siteId} onChange={(event) => setSiteId(Number(event.target.value))}>{(data?.sites ?? []).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></div><div className="directory-grid">{[["Смены", data?.shifts], ["Зоны", data?.zones], ["Основные работы", data?.mainWorkTypes], ["Виды подработ", data?.subworkTypes], ["Мастера", data?.masters]].map(([title, items]) => <article key={String(title)}><div><h3>{String(title)}</h3><span>{(items as Option[] | undefined)?.length ?? 0}</span></div><ul>{(items as Option[] | undefined)?.map((item) => <li key={item.id}>{item.name}<em>активно</em></li>)}</ul></article>)}</div></section>}
      </section>
    </main>
  );
}
