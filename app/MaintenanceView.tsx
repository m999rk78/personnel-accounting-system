"use client";

import "./maintenance.css";
import { maintenanceLogoSrc } from "./maintenanceLogo";

export function MaintenanceView({ kind, checking, onRetry }: {
  kind: "maintenance" | "unavailable";
  checking: boolean;
  onRetry: () => void;
}) {
  const unavailable = kind === "unavailable";
  return <div className="maintenance-page">
    <div className="maintenance-card">
      {/* eslint-disable-next-line @next/next/no-img-element -- Inline SVG data must work without an image server during downtime. */}
      <header className="maintenance-brand"><img src={maintenanceLogoSrc} alt="Югмонтажстрой" width={28} height={30} /><span>Ресурсный отчёт</span></header>
      <main className="maintenance-content">
        <h1 id="maintenance-title">{unavailable ? "Временно нет доступа" : "Технические работы"}</h1>
        <p className="maintenance-description">{unavailable ? "Проверяем соединение с сервером." : "Доступ к системе скоро возобновится."}</p>
        <button className="maintenance-retry" type="button" onClick={onRetry} disabled={checking}>{checking ? "Проверяем…" : "Проверить доступ"}</button>
        <p className="maintenance-preservation">Не закрывайте вкладку с незавершёнными изменениями.</p>
        <span className="maintenance-status" role="status" aria-live="polite">{checking ? "Проверяем доступ" : "Проверяем автоматически"}</span>
      </main>
    </div>
  </div>;
}
