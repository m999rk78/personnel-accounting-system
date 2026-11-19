import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuditLogView } from "../../app/AuditLogView";
import "../../app/globals.css";

function Fixture() {
  const [allowLinks, setAllowLinks] = useState(true);
  const [destination, setDestination] = useState("");
  return <main style={{ maxWidth: 1100, margin: "24px auto", padding: "0 24px" }}>
    <h1 style={{ margin: "0 0 20px", fontSize: 26 }}>Журнал действий</h1>
    <AuditLogView onBack={() => setDestination("Общие настройки")} canNavigate={() => allowLinks} onNavigate={async target => { setDestination(`${target.view} · проект ${target.siteId ?? "все"} · сотрудник ${target.employeeId ?? "все"} · ${target.month ?? ""}`); return true; }} />
    <aside style={{ marginTop: 24, padding: 12, background: "#f4f4f5", fontSize: 11 }}>
      <p>Изолированная проверка. Все имена и проекты вымышлены.</p>
      <button type="button" className="back-button" onClick={() => setAllowLinks(value => !value)}>{allowLinks ? "Запретить переходы" : "Разрешить переходы"}</button>
      <output style={{ display: "block", marginTop: 8 }}>{destination}</output>
    </aside>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
