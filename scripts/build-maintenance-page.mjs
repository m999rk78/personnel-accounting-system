// Produce one self-contained page for the application gateway and proxy fallback.
import { readFile, writeFile } from "node:fs/promises";

const css = await readFile(new URL("../app/maintenance.css", import.meta.url), "utf8");
const logo = await readFile(new URL("../public/tps-logo.svg", import.meta.url));
const logoSrc = `data:image/svg+xml;base64,${logo.toString("base64")}`;
await writeFile(new URL("../app/maintenanceLogo.ts", import.meta.url), `// Generated from public/tps-logo.svg by scripts/build-maintenance-page.mjs.\nexport const maintenanceLogoSrc = ${JSON.stringify(logoSrc)};\n`);
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light"><title>Технические работы · Ресурсный отчёт</title><style>${css}</style></head>
<body style="margin:0"><div class="maintenance-page">
<div class="maintenance-card"><header class="maintenance-brand"><img src="${logoSrc}" alt="Югмонтажстрой" width="28" height="30"><span>Ресурсный отчёт</span></header>
<main class="maintenance-content"><h1>Технические работы</h1><p class="maintenance-description">Доступ к системе скоро возобновится.</p><button class="maintenance-retry" type="button" id="maintenance-retry">Проверить доступ</button><p class="maintenance-preservation">Не закрывайте вкладку с незавершёнными изменениями.</p><span id="maintenance-status" class="maintenance-status" role="status" aria-live="polite">Проверяем автоматически</span></main></div></div>
<script>
(() => {
  const button = document.getElementById('maintenance-retry');
  const status = document.getElementById('maintenance-status');
  let checking = false;
  async function check() {
    if (checking) return;
    checking = true; button.disabled = true; status.textContent = 'Проверяем доступ…';
    try {
      const response = await fetch('/api/maintenance/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const state = response.ok ? await response.json() : null;
      // This document has no form or application drafts. Mounted workspaces use
      // MaintenanceBoundary instead and NEVER reload when service resumes.
      if (state?.maintenance === false && state.phase === 'ready') { if (location.pathname === '/maintenance.html') location.replace('/'); else location.reload(); return; }
      status.textContent = 'Работы ещё продолжаются';
    } catch { status.textContent = 'Проверяем автоматически'; }
    finally { checking = false; button.disabled = false; }
  }
  button.addEventListener('click', check);
  window.addEventListener('online', check);
  window.setInterval(() => { if (!document.hidden) void check(); }, 5000);
})();
</script></body></html>`;

await writeFile(new URL("../public/maintenance.html", import.meta.url), html);
