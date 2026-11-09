import { useState } from "react";

/** Optional visible clipboard target for manual/CUA checks with synthetic data only. */
export function SelectionCopyTarget() {
  const [value, setValue] = useState("ТЕСТОВЫЙ БУФЕР");
  if (!new URLSearchParams(location.search).has("selection")) return null;
  return <div style={{ display: "flex", flex: "0 0 auto", alignItems: "center", gap: 10, padding: 6, border: "1px solid #d4d4d8", background: "#fafafa", fontSize: 11 }}>
    <label style={{ display: "flex", flex: 1, gap: 8, alignItems: "center" }}>Проверка копирования<textarea aria-label="Проверка копирования" value={value} onChange={event => setValue(event.target.value)} rows={2} style={{ flex: 1, maxHeight: 42, minHeight: 36, fontSize: 11 }} /></label>
    <output aria-label="Размер скопированных данных">{value.split("\n").length} строк · {value.length} символов</output>
    <button type="button" onClick={() => setValue("")}>Очистить тестовый буфер</button>
  </div>;
}
