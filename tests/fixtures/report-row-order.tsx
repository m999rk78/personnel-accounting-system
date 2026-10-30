import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AllCommunityModule } from "ag-grid-community";
import { AgGridProvider } from "ag-grid-react";
import { PersonnelReportGrid, type PersonnelReportGridRow } from "../../app/PersonnelReportGrid";
import { TableOrderProvider } from "../../app/TableRowMoves";
import "../../app/globals.css";

const people = ["Первый сотрудник", "Второй сотрудник", "Третий сотрудник"].map((fullName, index) => ({ id: index + 1, fullName, employmentType: "ОПР", department: "Отдел", position: "Должность", source: "manual", siteId: 1, siteName: "Проверка" }));
const option = [{ id: 1, name: "Тестовое значение" }];
const initialRows: PersonnelReportGridRow[] = [
  { key: "report-11-101", date: "2026-10-28", person: 1, note: "Сегодня: первая работа" },
  { key: "report-11-102", date: "2026-10-28", person: 2, note: "Сегодня: второй сотрудник" },
  { key: "report-11-103", date: "2026-10-28", person: 1, note: "Сегодня: вторая работа" },
  { key: "report-12-104", date: "2026-10-27", person: 1, note: "Вчера: первый сотрудник" },
  { key: "report-12-105", date: "2026-10-27", person: 3, note: "Вчера: третий сотрудник" },
  { key: "d0471ab9-d379-46f2-af6e-51ed0be6cfbf", date: "2026-10-28", person: 0, note: "Новая пустая строка" },
].map(({ key, date, person, note }) => ({
  rowKey: key, workDate: date, createdAt: `${date}T08:00:00Z`, status: "draft", editable: true,
  draft: { key, employeeId: person ? String(person) : "", employeeQuery: people.find(p => p.id === person)?.fullName ?? "", shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", masterId: "1", hours: "8", note },
}));
function Fixture() {
  const [rows, setRows] = useState(initialRows);
  return <main style={{ height: "100vh", minHeight: 600, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
    <h1>Перенос строк отчёта</h1><p>Проверка: повторные записи одного сотрудника за два дня и пустая строка. Рабочая база не подключена.</p>
    <TableOrderProvider scope="personnel-report-rows" siteId={1}>
      <PersonnelReportGrid rows={rows} today="2026-10-28" loading={false} canCreate canReview employees={people} shifts={option} zones={option} mainWorkTypes={option} subworkTypes={option.map(item => ({ ...item, mainWorkTypeId: 1 }))} masters={option}
        onPatchDraft={(key, changes) => setRows(current => current.map(row => row.rowKey === key ? { ...row, draft: { ...row.draft!, ...changes } } : row))}
        onSelectionChange={() => {}} onCopyRows={() => {}} onValidationError={() => {}} onApplyRange={() => true}
        history={{ canUndo: false, canRedo: false, undo: () => {}, redo: () => {} }} />
    </TableOrderProvider>
    <output aria-label="Содержимое черновиков">{rows.map(row => `${row.workDate} ${row.rowKey}: ${row.draft?.hours} ч; ${row.draft?.note}`).join(" · ")}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllCommunityModule]}><Fixture /></AgGridProvider>);
