import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { PersonnelReportWorkspace } from "../../app/PersonnelReportWorkspace";
import { EquipmentReportWorkspace } from "../../app/EquipmentReportWorkspace";
import { TableOrderProvider } from "../../app/TableRowMoves";
import { rolePermissionTemplate } from "../../app/permissionModel";
import type { UserRole } from "../../app/roles";
import "../../app/globals.css";

function Fixture() {
  const [domain, setDomain] = useState("personnel");
  const [scenario, setScenario] = useState("draft_editor");
  const resource = domain === "personnel" ? "workers_report" : "equipment_report";
  const role: UserRole = scenario === "foreman" ? "foreman" : "engineer";
  const permissions = rolePermissionTemplate(role);
  const none = { view: false, create: false, update: false, delete: false };
  const readOnly = { ...none, view: true };
  if (scenario === "draft_editor") {
    permissions[`${resource}_submitted`] = { ...readOnly };
    permissions[`${resource}_approved`] = { ...readOnly };
  } else if (scenario === "approved_editor") {
    permissions[`${resource}_draft`] = { ...none };
    permissions[`${resource}_submitted`] = { ...none };
  } else if (scenario === "reviewer_no_publish") {
    permissions[`${resource}_draft`] = { ...none };
    permissions[`${resource}_approved`] = { ...readOnly };
  } else if (scenario === "delete_only") {
    permissions[resource].create = false;
    permissions[resource].update = false;
    permissions[`${resource}_draft`] = { ...none };
    permissions[`${resource}_submitted`] = { ...none };
    permissions[`${resource}_approved`] = { ...readOnly, delete: true };
  }
  const user = { id: 20, fullName: "Проверяющий пользователь", role, permissions };
  const option = [{ id: 1, name: "Доступное значение", mainWorkTypeId: 1 }];
  const shared = { siteId: 1, siteName: "Изолированный проект", today: "2026-11-09", currentUser: user,
    permissions: permissions[resource], shifts: option, zones: option, mainWorkTypes: option, subworkTypes: option, masters: option, loading: false };
  return <main style={{ minHeight: "100vh", padding: 16 }}>
    <nav style={{ display: "flex", gap: 16, marginBottom: 16 }}>
      <strong>Изолированный стенд — без рабочей БД</strong>
      <select aria-label="Раздел проверки" value={domain} onChange={event => setDomain(event.target.value)}><option value="personnel">Персонал</option><option value="equipment">Техника</option></select>
      <select aria-label="Права проверки" value={scenario} onChange={event => setScenario(event.target.value)}><option value="draft_editor">Редактор черновиков</option><option value="approved_editor">Редактор подтверждённых</option><option value="reviewer_no_publish">Проверяющий без подтверждения</option><option value="delete_only">Только удаление подтверждённых</option><option value="foreman">Обычный прораб</option></select>
    </nav>
    <div className="page-content personnel-report-page table-workspace-page personnel-report-page-scroll">
      <TableOrderProvider key={`${domain}:${scenario}`} scope={domain === "personnel" ? "personnel-report-rows" : "equipment-report-rows"} siteId={1}>
        {domain === "personnel" ? <PersonnelReportWorkspace {...shared} employees={[{ id: 1, fullName: "Иван Тестовый", employmentType: "ОПР", department: "Участок", position: "Монтажник", source: "fixture", siteId: 1, siteName: "Изолированный проект" }]} />
          : <EquipmentReportWorkspace {...shared} units={[{ id: 1, equipmentType: "Экскаватор", brand: "Тест", model: "ЭК-1", registrationNumber: "ТЕСТ", organization: "Учебная механизация", note: "" }]} />}
      </TableOrderProvider>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider>);
