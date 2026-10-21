import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TimesheetView } from "../../app/TimesheetView";
import { EquipmentAccountingView } from "../../app/EquipmentAccountingView";
import "../../app/globals.css";

function TableSmoke() {
  const [screen, setScreen] = useState<"workers" | "equipment" | "registry">("workers");
  const equipment = screen !== "workers";
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16 }}>
    <nav><strong>Только тестовые данные — изменения не затрагивают рабочую систему</strong>{" "}
      <button onClick={() => setScreen("workers")}>Рабочие (2000)</button>{" "}
      <button onClick={() => setScreen("equipment")}>Техника (1000)</button>{" "}
      <button onClick={() => setScreen("registry")}>Реестр (1000)</button>
    </nav>
    <div className="timesheet-workspace-page" style={{ flex: 1, minHeight: 0 }}>
      <div id={equipment ? "equipment-timesheet-actions" : "personnel-timesheet-actions"} />
      {equipment
        ? <EquipmentAccountingView key={screen} siteId={1} initialDate="2026-10-21" initialMonth="2026-10" today="2026-10-21" mode={screen === "registry" ? "registry" : "month"} />
        : <TimesheetView siteId={1} initialMonth="2026-10" today="2026-10-21" />}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<TableSmoke />);
