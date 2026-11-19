import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgGridProvider } from "ag-grid-react";
import { AllCommunityModule } from "ag-grid-community";
import { UserAccessCards } from "../../app/UserAccessCards";
import { PermissionMatrix } from "../../app/PermissionMatrix";
import { rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

const users = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, fullName: `Тестовый пользователь ${index + 1}`, email: `user${index + 1}@example.invalid`, role: "viewer" as const, assignedSiteId: null, status: "active" as const }));
window.fetch = async () => Response.json({ error: "Изолированный стенд" }, { status: 403 });
function Fixture() {
  const [kind, setKind] = useState("users"), [mutations, setMutations] = useState(0);
  const mutation = () => setMutations(value => value + 1);
  return <div style={{ padding: 24 }}>
    <button onClick={() => setKind("users")}>Пользователи</button><button onClick={() => setKind("permissions")}>Права</button>
    <output aria-label="Изменений данных">{mutations}</output>
    {kind === "users" ? <UserAccessCards rows={users} drafts={[]} sites={[]} selectedIds={[]} layout="list" saving={false}
      onEdit={mutation} onSelectionChange={mutation} onPatchDraft={mutation} onCancelEditing={() => {}} onSave={mutation} />
      : <PermissionMatrix label="Тестовые права" value={rolePermissionTemplate("viewer")} onChange={mutation} compact />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllCommunityModule]}><Fixture /></AgGridProvider>);
