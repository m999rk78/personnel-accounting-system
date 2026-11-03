import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MaintenanceBoundary } from "../../app/MaintenanceBoundary";
import { TimesheetView } from "../../app/TimesheetView";
import "../../app/globals.css";

function Workspace() {
  const [draft, setDraft] = useState("");
  const [stats, setStats] = useState({ writes: 0 });
  useEffect(() => {
    let mounted = true;
    const refresh = () => void fetch("/__smoke/stats").then(response => response.json()).then(value => { if (mounted) setStats(value); });
    refresh(); const interval = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, []);
  return <main style={{ height: "100vh", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
    <h1 style={{ fontSize: 25 }}>Локальная проверка технических работ</h1>
    <p>Только вымышленные данные. Рабочая база и внешние сервисы не подключены.</p>
    <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" className="secondary-button" onClick={() => void fetch("/__smoke/start", { method: "POST" })}>Работы через 3 секунды на 120 секунд</button>
      <label>Черновик <input aria-label="Тестовый черновик" value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <output aria-label="Счётчик сохранений">Сохранений: {stats.writes}</output>
    </div>
    <div className="timesheet-workspace-page" style={{ minHeight: 0, flex: 1 }}><TimesheetView siteId={1} initialMonth="2026-11" today="2026-11-02" /></div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<MaintenanceBoundary><Workspace /></MaintenanceBoundary>);
