import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { EquipmentReportWorkspace } from "../../app/EquipmentReportWorkspace";
import { ExcelExportPreviewPage } from "../../app/ExcelExportPreview";
import { TableOrderProvider } from "../../app/TableRowMoves";
import { equipmentReportOrderScope } from "../../app/equipmentReportRowOrder";
import type { GridEquipmentUnit, GridOption } from "../../app/AgDataGrids";
import type { UserRole } from "../../app/roles";
import "../../app/globals.css";

type Scenario = "default" | "workflow" | "conflicts";
type FixtureCatalog = {
  today: string; site: { id: number; name: string }; units: GridEquipmentUnit[];
  shifts: GridOption[]; zones: GridOption[]; mainWorkTypes: GridOption[]; subworkTypes: GridOption[]; scenario: Scenario;
};
function fixtureActor(id: number, fullName: string, role: UserRole, canViewPendingReports = role !== "viewer") {
  const permission = { view: true, create: role !== "viewer", update: role !== "viewer", delete: role !== "viewer" };
  return { id, fullName, role, assignedSiteId: 1, projectAccess: { mode: "selected" as const, siteIds: [1] }, canViewPendingReports,
    permissions: { equipment_report: { ...permission }, equipment_timesheet: { ...permission } } };
}
const actors = {
  foreman: fixtureActor(10, "Алексей Тестовый", "foreman"),
  foreman2: fixtureActor(11, "Борис Другая Бригада", "foreman"),
  engineer: fixtureActor(20, "Ирина Проверяющая", "engineer"),
  superadmin: fixtureActor(30, "Администратор Проверки", "superadmin"),
  viewer: fixtureActor(40, "Виктор Наблюдатель", "viewer"),
  viewer_pending: fixtureActor(41, "Вера Расширенный Просмотр", "viewer", true),
};
type FixtureStatus = {
  materializedHours: number; approvedEntryCount: number;
  byDate: { workDate: string; reportCount: number; draftRows: number; submittedRows: number; approvedRows: number; productiveHours: number; downtimeHours: number }[];
  reports: { id: number; ownerUserId: number; status: string; revision: number; workDate: string; rowCount: number }[];
  requestCounts: { validation: number; save: number; submit: number; mutations: number; approvedEdits: number };
};
function FixtureBalances({ today }: { today: string }) {
  const [status, setStatus] = useState<FixtureStatus | null>(null);
  const [todayHours, setTodayHours] = useState<{ productive: number; downtime: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [statusResponse, timesheetResponse] = await Promise.all([fetch("/__smoke/status", { signal: controller.signal }), fetch(`/api/equipment-timesheet?siteId=1&month=${today.slice(0, 7)}`, { signal: controller.signal })]);
        if (!statusResponse.ok || !timesheetResponse.ok) throw new Error("Не удалось проверить учебный табель.");
        const next = await statusResponse.json() as FixtureStatus;
        const timesheet = await timesheetResponse.json() as { entries: { workDate: string; productiveHours: number; downtimeHours: number }[] };
        if (controller.signal.aborted) return;
        setStatus(next);
        setTodayHours(timesheet.entries.filter(entry => entry.workDate === today).reduce((sum, entry) => ({ productive: sum.productive + entry.productiveHours, downtime: sum.downtime + entry.downtimeHours }), { productive: 0, downtime: 0 }));
        setError("");
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Ошибка учебного табеля"); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 800);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [today]);
  return <aside aria-label="Контроль тестового табеля техники" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 14, padding: "7px 12px", fontSize: 11, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8 }}>
    <strong aria-live="polite">В табеле сегодня: работа {todayHours?.productive ?? "…"} ч · простой {todayHours?.downtime ?? "…"} ч</strong>
    <span>Всего подтверждено: {status?.materializedHours ?? "…"} ч / {status?.approvedEntryCount ?? "…"} записей</span>
    <span>Черновиков: {status?.reports.filter(report => ["draft", "rejected"].includes(report.status)).length ?? "…"}; на проверке: {status?.reports.filter(report => report.status === "submitted").length ?? "…"}</span>
    <span aria-label="Счётчики запросов">Проверок: {status?.requestCounts.validation ?? "…"}; сохранений: {status?.requestCounts.save ?? "…"}; отправок: {status?.requestCounts.submit ?? "…"}; изменений: {status?.requestCounts.mutations ?? "…"}; правок подтверждённых: {status?.requestCounts.approvedEdits ?? "…"}</span>
    <details><summary>Контроль по датам</summary>{status?.byDate.map(balance => <span key={balance.workDate} data-smoke-date={balance.workDate} style={{ display: "block", paddingTop: 4 }}>
      {balance.workDate}: черновик {balance.draftRows} строк; на проверке {balance.submittedRows}; подтверждено {balance.approvedRows} · работа {balance.productiveHours} ч · простой {balance.downtimeHours} ч
    </span>)}</details>
    {error && <span role="alert">{error}</span>}
  </aside>;
}
function EquipmentReportSmoke() {
  const [role, setRole] = useState<keyof typeof actors>("foreman");
  const [session, setSession] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [catalog, setCatalog] = useState<FixtureCatalog | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/__smoke/catalog", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Не удалось прочитать учебный каталог.");
      const data = await response.json() as FixtureCatalog;
      if (!controller.signal.aborted) setCatalog(data);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Ошибка учебного каталога"); });
    return () => controller.abort();
  }, []);
  const reset = async (scenario = catalog?.scenario) => {
    try {
      const response = await fetch("/__smoke/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario }) });
      if (!response.ok) throw new Error("Не удалось сбросить учебные данные.");
      setCatalog(current => current && scenario ? { ...current, scenario } : current); setDirty(false); setSession(value => value + 1); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Ошибка сброса"); }
  };
  return <main className="page-content personnel-report-page table-workspace-page personnel-report-page-scroll" style={{ minHeight: "100vh", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
    <nav style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontSize: 12 }}>
      <strong>Изолированный стенд техники — рабочая база не подключена</strong>
      <label>Роль в проверке{" "}<select aria-label="Роль в проверке" value={role} onChange={event => {
        const next = event.target.value as keyof typeof actors; document.cookie = `equipment_smoke_role=${next}; path=/; SameSite=Lax`; setDirty(false); setRole(next);
      }}><option value="foreman">Прораб — Алексей Тестовый</option><option value="foreman2">Прораб — Борис Другая Бригада</option><option value="engineer">Инженер — Ирина Проверяющая</option><option value="superadmin">Супер-админ — Администратор Проверки</option><option value="viewer">Просмотр — только подтверждённые</option><option value="viewer_pending">Просмотр — включая отчёты на проверке</option></select></label>
      <label>Сценарий{" "}<select aria-label="Сценарий" value={catalog?.scenario ?? "workflow"} disabled={!catalog} onChange={event => void reset(event.target.value as Scenario)}>
        <option value="workflow">Несколько дат и бригад</option><option value="default">История и перенос техники</option><option value="conflicts">Лимит 20 ч и недоступная техника</option>
      </select></label>
      <button type="button" onClick={() => void reset()}>Сбросить тестовые данные</button>
      <span aria-live="polite">{dirty ? "Есть несохранённые изменения" : "Изменения сохранены"}</span>
    </nav>
    {catalog && <FixtureBalances today={catalog.today} />}
    {error && <p role="alert">{error}</p>}
    <div className="page-toolbar" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 28 }}>Отчёт техники</h1><div id="equipment-report-views" /><div id="equipment-report-actions" style={{ marginLeft: "auto" }} />
    </div>
    <div className="timesheet-workspace-page" style={{ flex: 1, minHeight: 0 }}>
      {catalog ? <TableOrderProvider key={`${role}-${session}`} scope={equipmentReportOrderScope} siteId={catalog.site.id}>
        <EquipmentReportWorkspace siteId={catalog.site.id} siteName={catalog.site.name} today={catalog.today} currentUser={actors[role]} permissions={actors[role].permissions.equipment_report}
          units={catalog.units} shifts={catalog.shifts} zones={catalog.zones} mainWorkTypes={catalog.mainWorkTypes} subworkTypes={catalog.subworkTypes} loading={false} onDirtyChange={setDirty} />
      </TableOrderProvider> : !error && <p>Загрузка учебного каталога…</p>}
    </div>
  </main>;
}
if (window.location.pathname !== "/excel-preview") document.cookie = "equipment_smoke_role=foreman; path=/; SameSite=Lax";
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}>{window.location.pathname === "/excel-preview" ? <ExcelExportPreviewPage /> : <EquipmentReportSmoke />}</AgGridProvider>);
