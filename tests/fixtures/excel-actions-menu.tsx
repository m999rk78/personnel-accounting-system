import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExcelActionsMenu } from "../../app/ExcelActionsMenu";
import "../../app/globals.css";
import "../../app/personnelReport.css";

function Fixture() {
  const [action, setAction] = useState("");
  const [importDisabled, setImportDisabled] = useState(false);
  return <main style={{ padding: 24 }}>
    <section aria-label="Отчёт персонала" style={{ position: "fixed", top: 35.5, left: 34.25 }}>
      <div className="personnel-report-header-actions">
        <button type="button" className="secondary-button personnel-report-queue-button">По датам <span>1</span></button>
        <ExcelActionsMenu actions={[
          { label: "Экспорт подтверждённых", onSelect: () => setAction("Экспорт") },
          { label: "Импорт в черновик", disabled: importDisabled, onSelect: () => setAction("Импорт") },
          { label: "Скачать шаблон", onSelect: () => setAction("Шаблон") },
        ]} />
      </div>
    </section>
    <section aria-label="Обычная панель" style={{ marginTop: 180 }}><ExcelActionsMenu actions={[{ label: "Экспорт в Excel", onSelect: () => setAction("Экспорт") }]} /></section>
    <label><input type="checkbox" checked={importDisabled} onChange={event => setImportDisabled(event.target.checked)} />Импорт недоступен</label>
    <output>{action}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
