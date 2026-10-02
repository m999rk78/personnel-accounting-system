"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";
import { ROLE_LABELS, type UserRole } from "./roles";

type AuditEvent = {
  id: number;
  actorUserId: number | null;
  actorName: string;
  actorRole: UserRole;
  category: string;
  actionKey: string;
  entityType: string;
  entityId: string;
  siteId: number | null;
  siteName: string;
  summary: string;
  beforeData: unknown;
  afterData: unknown;
  createdAt: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  reports: "Отчёты",
  timesheets: "Табели",
  directories: "Справочники",
  access: "Пользователи и права",
  equipment: "Техника",
  integration: "Интеграции",
  account: "Учётная запись",
};

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function detailText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function AuditLogView({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const requestEvents = useCallback(async () => {
    const response = await fetch("/api/audit-log?limit=500", { cache: "no-store" });
    const payload = await response.json() as { events?: AuditEvent[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить журнал действий.");
    return payload.events ?? [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestEvents()
      .then((nextEvents) => { if (!cancelled) setEvents(nextEvents); })
      .catch((loadError: unknown) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить журнал действий."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [requestEvents]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setEvents(await requestEvents());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить журнал действий.");
    } finally {
      setLoading(false);
    }
  }, [requestEvents]);

  const categories = useMemo(() => Array.from(new Set(events.map((event) => event.category))).sort(), [events]);
  const visibleEvents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    return events.filter((event) => {
      if (category !== "all" && event.category !== category) return false;
      if (!query) return true;
      return [event.actorName, event.summary, event.siteName, CATEGORY_LABELS[event.category] ?? event.category]
        .some((value) => value.toLocaleLowerCase("ru-RU").includes(query));
    });
  }, [category, events, search]);

  return <section className="audit-log-page">
    <div className="settings-toolbar audit-log-toolbar">
      <button type="button" className="back-button" onClick={onBack}>← К общим настройкам</button>
      <button type="button" className="back-button" onClick={() => void loadEvents()} disabled={loading}>{loading ? "Обновляем…" : "Обновить"}</button>
    </div>
    <div className="audit-log-intro"><div><strong>Неизменяемая история действий</strong><span>Записи создаются сервером после успешного сохранения. Пользователи не могут редактировать или удалять события журнала.</span></div><span className="audit-log-count">{visibleEvents.length} событий</span></div>
    <div className="audit-log-filters">
      <label className="audit-log-filter-field"><span>Поиск</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Сотрудник, действие или проект" /></label>
      <div className="audit-log-filter-field"><span>Раздел</span><CustomSelect className="audit-log-category-select" value={category} ariaLabel="Раздел журнала" onChange={setCategory} options={[{ value: "all", label: "Все разделы" }, ...categories.map((value) => ({ value, label: CATEGORY_LABELS[value] ?? value }))]} /></div>
    </div>
    {error && <div className="message error inline-message"><strong>Не удалось загрузить журнал</strong><span>{error}</span></div>}
    {!error && loading && <div className="audit-log-empty">Загружаем историю действий…</div>}
    {!error && !loading && !visibleEvents.length && <div className="audit-log-empty"><strong>Записей пока нет</strong><span>Новые изменения появятся здесь после сохранения отчёта, табеля или настроек.</span></div>}
    {!error && !loading && Boolean(visibleEvents.length) && <div className="audit-log-list">{visibleEvents.map((event) => {
      const isExpanded = expanded.has(event.id);
      return <article className="audit-log-event" key={event.id}>
        <div className={`audit-log-marker ${event.category}`} aria-hidden="true" />
        <div className="audit-log-main">
          <div className="audit-log-event-heading"><div><strong>{event.summary}</strong><span>{event.actorName} · {ROLE_LABELS[event.actorRole] ?? event.actorRole}</span></div><time dateTime={event.createdAt}>{DATE_TIME.format(new Date(event.createdAt))}</time></div>
          <div className="audit-log-meta"><span>{CATEGORY_LABELS[event.category] ?? event.category}</span>{event.siteName && <span>{event.siteName}</span>}{event.entityId && <span>ID {event.entityId}</span>}</div>
          {(event.beforeData !== null || event.afterData !== null) && <button type="button" className="audit-log-details-button" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(event.id)) next.delete(event.id); else next.add(event.id); return next; })}>{isExpanded ? "Скрыть подробности" : "Показать подробности"}</button>}
          {isExpanded && <div className="audit-log-details">{event.beforeData !== null && <section><h3>До изменения</h3><pre>{detailText(event.beforeData)}</pre></section>}<section><h3>Сохранённое действие</h3><pre>{detailText(event.afterData)}</pre></section></div>}
        </div>
      </article>;
    })}</div>}
  </section>;
}
