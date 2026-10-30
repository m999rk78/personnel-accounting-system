import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { PersonnelReportWorkspace } from "../../app/PersonnelReportWorkspace";
import { ExcelExportPreviewPage } from "../../app/ExcelExportPreview";
import type { GridEmployee, GridOption } from "../../app/AgDataGrids";
import "../../app/globals.css";

const today = "2026-10-28";
type FixtureCatalog = {
  site: { id: number; name: string };
  employees: GridEmployee[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  masters: GridOption[];
  scenario: "default" | "workflow" | "conflicts";
  runtimeCatalog: boolean;
};
const permissions = { create: true, update: true, delete: true };
const actors = {
  foreman: { id: 10, fullName: "Алексей Тестовый", role: "foreman" as const },
  foreman2: { id: 11, fullName: "Борис Другая Бригада", role: "foreman" as const },
  superadmin: { id: 30, fullName: "Администратор Проверки", role: "superadmin" as const },
  engineer: { id: 20, fullName: "Ирина Проверяющая", role: "engineer" as const },
};

type FixtureStatus = {
  todayHours: number;
  yesterdayHours: number;
  approvedEntryCount: number;
  byDate: { workDate: string; reportCount: number; draftRows: number; submittedRows: number; approvedRows: number; approvedHours: number }[];
  reports: { id: number; status: string; revision: number; workDate: string; rowCount: number }[];
  requestCounts: { validation: number; save: number; submit: number; mutations: number };
};

function FixtureBalances() {
  const [status, setStatus] = useState<FixtureStatus | null>(null);
  const [timesheetHours, setTimesheetHours] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [statusResponse, timesheetResponse] = await Promise.all([
          fetch("/__smoke/status", { signal: controller.signal }),
          fetch(`/api/timesheet?siteId=1&month=${today.slice(0, 7)}`, { signal: controller.signal }),
        ]);
        const nextStatus = await statusResponse.json() as FixtureStatus;
        const timesheet = await timesheetResponse.json() as { entries: { workDate: string; hours: number }[] };
        if (controller.signal.aborted) return;
        setStatus(nextStatus);
        setTimesheetHours(timesheet.entries.filter((entry) => entry.workDate === today).reduce((total, entry) => total + entry.hours, 0));
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось проверить тестовый табель");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 800);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  return <aside style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 18, padding: "7px 12px", fontSize: 11, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8 }} aria-label="Контроль тестового табеля">
    <strong aria-live="polite">Учтено в табеле сегодня: {timesheetHours ?? "…"} ч</strong>
    <span>Вчера подтверждено: {status?.yesterdayHours ?? "…"} ч</span>
    <span>Черновиков: {status?.reports.filter((report) => report.status === "draft" || report.status === "rejected").length ?? "…"}</span>
    <span>На проверке: {status?.reports.filter((report) => report.status === "submitted").length ?? "…"}</span>
    <strong aria-label="Счётчики запросов">Проверок: {status?.requestCounts.validation ?? "…"}; сохранений: {status?.requestCounts.save ?? "…"}; отправок: {status?.requestCounts.submit ?? "…"}; изменений: {status?.requestCounts.mutations ?? "…"}</strong>
    <details><summary>Проверка по датам</summary>{status?.byDate.map((balance) => <span style={{ display: "block", paddingTop: 4 }} key={balance.workDate} data-smoke-date={balance.workDate}>
      {balance.workDate}: отчётов {balance.reportCount}; черновик {balance.draftRows} строк; на проверке {balance.submittedRows} строк; подтверждено {balance.approvedRows} строк / {balance.approvedHours} ч
    </span>)}</details>
    {error ? <span role="alert">{error}</span> : null}
  </aside>;
}

function PersonnelReportSmoke() {
  const [role, setRole] = useState<keyof typeof actors>("foreman");
  const [session, setSession] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [catalog, setCatalog] = useState<FixtureCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/__smoke/catalog", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Не удалось прочитать тестовый каталог.");
      const result = await response.json() as FixtureCatalog;
      if (!controller.signal.aborted) setCatalog(result);
    }).catch((cause) => { if (!controller.signal.aborted) setCatalogError(cause instanceof Error ? cause.message : "Ошибка тестового каталога"); });
    return () => controller.abort();
  }, []);
  return <main style={{ height: "100vh", minHeight: 650, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
    <nav style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <strong>Изолированный стенд — рабочая база не подключена</strong>
      <label>Роль в проверке{" "}<select aria-label="Роль в проверке" value={role} onChange={(event) => {
        const nextRole = event.target.value as keyof typeof actors;
        document.cookie = `personnel_smoke_role=${nextRole}; path=/; SameSite=Lax`;
        setDirty(false);
        setRole(nextRole);
      }}>
        <option value="foreman">Прораб — Алексей Тестовый</option>
        <option value="foreman2">Прораб — Борис Другая Бригада</option>
        <option value="superadmin">Супер-админ — Администратор Проверки</option>
        <option value="engineer">Инженер — Ирина Проверяющая</option>
      </select></label>
      <span aria-live="polite">{dirty ? "Есть несохранённые изменения" : "Изменения сохранены"}</span>
      <label>Сценарий{" "}<select aria-label="Сценарий" value={catalog?.scenario ?? "default"} disabled={!catalog || catalog.runtimeCatalog} onChange={async (event) => {
        const scenario = event.target.value as FixtureCatalog["scenario"];
        const response = await fetch("/__smoke/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario }) });
        if (!response.ok) return;
        setCatalog(current => current ? { ...current, scenario } : current);
        setDirty(false);
        setSession(value => value + 1);
      }}>
        <option value="default">Обычный</option><option value="workflow">Несколько дат и бригад</option><option value="conflicts">Конфликты часов: 2 сотрудника / 2 даты</option>
      </select></label>
      <button type="button" onClick={async () => {
        await fetch("/__smoke/reset", { method: "POST" });
        setDirty(false);
        setSession((value) => value + 1);
      }}>Сбросить тестовые данные</button>
    </nav>
    <FixtureBalances />
    {catalogError && <p role="alert">{catalogError}</p>}
    <div className="timesheet-workspace-page" style={{ flex: 1, minHeight: 0 }}>
      {catalog ? <PersonnelReportWorkspace key={`${role}-${session}`} siteId={catalog.site.id} siteName={catalog.site.name} today={today}
        currentUser={actors[role]} permissions={permissions} employees={catalog.employees}
        shifts={catalog.shifts} zones={catalog.zones} mainWorkTypes={catalog.mainWorkTypes} subworkTypes={catalog.subworkTypes} masters={catalog.masters}
        loading={false} onDirtyChange={setDirty} /> : !catalogError && <p>Загрузка тестового каталога…</p>}
    </div>
  </main>;
}

if (window.location.pathname !== "/excel-preview") document.cookie = "personnel_smoke_role=foreman; path=/; SameSite=Lax";
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}>{window.location.pathname === "/excel-preview" ? <ExcelExportPreviewPage /> : <PersonnelReportSmoke />}</AgGridProvider>);
