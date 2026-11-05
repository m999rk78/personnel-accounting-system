import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { PersonnelReportGrid, type PersonnelReportGridRow } from "../../app/PersonnelReportGrid";
import { EquipmentReportGrid, type EquipmentReportGridRow } from "../../app/EquipmentReportGrid";
import "../../app/globals.css";

const today = "2026-11-03";
const zones = [{ id: 1, name: "Зона оборудования — участок монтажа технологических трубопроводов" }, { id: 2, name: "Зона металлоконструкций — участок сборки и установки оборудования" }];
const works = [{ id: 1, name: "Монтаж технологических трубопроводов и металлоконструкций" }, { id: 2, name: "Подготовка площадки и перемещение строительных материалов" }];
const shifts = [{ id: 1, name: "день" }, { id: 2, name: "ночь" }];
const subworkTypes = [{ id: 1, name: "Подготовка", mainWorkTypeId: 1 }, { id: 2, name: "Перемещение", mainWorkTypeId: 2 }];
const employees = [{ id: 1, fullName: "Проверяемый сотрудник", employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 1, siteName: "Тестовый проект" }];
const units = [{ id: 1, equipmentType: "Кран", brand: "Тестовая марка", model: "Тестовая модель", registrationNumber: "ТЕСТ-001", organization: "Тестовая организация", note: "" }];
const commonDraft = { shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", hours: "8", note: "Исходное примечание" };
const personnelRows: PersonnelReportGridRow[] = [{ rowKey: "personnel-1", workDate: today, status: "draft", editable: true, draft: { ...commonDraft, key: "personnel-1", employeeId: "1", employeeQuery: employees[0].fullName, masterId: "1" } }];
const equipmentRows: EquipmentReportGridRow[] = [{ rowKey: "equipment-1", workDate: today, status: "draft", editable: true, draft: { ...commonDraft, key: "equipment-1", equipmentId: "1", equipmentQuery: "Тестовый кран" } }];
const history = { canUndo: false, canRedo: false, undo() {}, redo() {} };

function Fixture() {
  const [kind, setKind] = useState("personnel");
  const [people, setPeople] = useState(personnelRows);
  const [equipment, setEquipment] = useState(equipmentRows);
  const [groupByDate, setGroupByDate] = useState(false);
  const [revision, setRevision] = useState(0);
  return <main style={{ padding: 16, height: "100dvh", display: "flex", flexDirection: "column", gap: 10 }}>
    <h1 style={{ margin: 0 }}>Ширина столбцов — изолированная проверка</h1>
    <p style={{ margin: 0 }}>Только тестовые данные. Подключения к рабочей базе и внешним API нет.</p>
    <nav style={{ display: "flex", gap: 8 }}><button type="button" onClick={() => setKind("personnel")}>Персонал</button><button type="button" onClick={() => setKind("equipment")}>Техника</button><button type="button" onClick={() => setRevision(value => value + 1)}>Обновить данные</button>{kind === "personnel" && <label><input type="checkbox" checked={groupByDate} onChange={event => setGroupByDate(event.target.checked)}/>По датам</label>}</nav>
    {kind === "personnel" ? <PersonnelReportGrid rows={people.map(row => ({ ...row }))} groupByDate={groupByDate} today={today} loading={false} canCreate canReview employees={employees} shifts={shifts} zones={zones.map(zone => ({ ...zone }))} mainWorkTypes={works} subworkTypes={subworkTypes} masters={[{ id: 1, name: "Проверяемый мастер" }]}
      onPatchDraft={(key, changes) => setPeople(current => current.map(row => row.draft?.key === key ? { ...row, draft: { ...row.draft, ...changes } } : row))}
      onApplyRange={() => false} history={history} onSelectionChange={() => {}} onCopyRows={() => {}} onValidationError={() => {}}/>
      : <EquipmentReportGrid rows={equipment.map(row => ({ ...row }))} today={today} loading={false} canCreate canReview units={units} shifts={shifts} zones={zones.map(zone => ({ ...zone }))} mainWorkTypes={works} subworkTypes={subworkTypes}
        onPatchDraft={(key, changes) => setEquipment(current => current.map(row => row.draft?.key === key ? { ...row, draft: { ...row.draft, ...changes } } : row))}
        onApplyRange={() => false} history={history} onSelectionChange={() => {}} onCopyRows={() => {}} onValidationError={() => {}}/>}
    <output aria-label="Данные проверки">{JSON.stringify({ revision, rows: kind === "personnel" ? people : equipment })}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><Fixture/></AgGridProvider></StrictMode>);
