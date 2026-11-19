"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CustomSelect } from "./CustomSelect";
import { isUserRole, ROLE_LABELS } from "./roles";
import { presentAuditEvent, type AuditDetailField, type AuditEvent, type AuditEventPresentation, type AuditRelatedLink } from "./auditEventPresentation";
import type { AuditNavigationTarget } from "./auditNavigation";
import "./auditLog.css";

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

function AuditFields({ fields }: { fields: AuditDetailField[] }) {
  return <dl className="audit-detail-fields">{fields.map((field, index) => <div className="audit-detail-field" key={`${field.label}-${index}`}>
    <dt>{field.label}</dt>
    <dd>{field.before !== undefined && <><span className="audit-detail-before"><span className="sr-only">Было: </span>{field.before}</span><span className="audit-detail-arrow" aria-hidden="true">→</span><span className="sr-only">Стало: </span></>}<span className={field.before !== undefined ? "audit-detail-after" : undefined}>{field.value}</span></dd>
  </div>)}</dl>;
}

function eventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Время не сохранено" : DATE_TIME.format(date);
}

function AuditEventDetails({ eventId, details, links, navigating, onNavigate }: {
  eventId: number; details: AuditEventPresentation; links: AuditRelatedLink[]; navigating: boolean;
  onNavigate: (target: AuditNavigationTarget) => Promise<void>;
}) {
  const [sectionCount, setSectionCount] = useState(20);
  const [linkCount, setLinkCount] = useState(8);
  return <div className="audit-event-details" id={`audit-details-${eventId}`}>
    {details.context.length > 0 && <div className="audit-detail-context"><AuditFields fields={details.context} /></div>}
    {details.sections.slice(0, sectionCount).map((section, index) => <section className="audit-detail-section" key={`${section.title}-${index}`}><h3>{section.title}</h3><AuditFields fields={section.fields} /></section>)}
    {details.sections.length > sectionCount && <button type="button" className="audit-show-more" onClick={() => setSectionCount(count => count + 20)}>Показать ещё {Math.min(20, details.sections.length - sectionCount)} · осталось {details.sections.length - sectionCount}</button>}
    {details.notes.map((note, index) => <p className="audit-detail-note" key={index}>{note}</p>)}
    {links.length > 0 && <nav className="audit-related-links" aria-label="Связанные разделы"><span>Перейти</span>{links.slice(0, linkCount).map((link, index) => <button type="button" className="audit-related-link" key={`${link.label}-${index}`} disabled={navigating} onClick={() => void onNavigate(link.target)}>{link.label}<span aria-hidden="true">↗</span></button>)}{links.length > linkCount && <button type="button" className="audit-show-more" onClick={() => setLinkCount(count => count + 8)}>Ещё переходы ({links.length - linkCount})</button>}</nav>}
  </div>;
}

export function AuditLogView({ onBack, headerActionsTargetId, canNavigate, onNavigate }: {
  onBack: () => void;
  headerActionsTargetId?: string;
  canNavigate?: (target: AuditNavigationTarget) => boolean;
  onNavigate?: (target: AuditNavigationTarget) => Promise<boolean>;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLElement | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState("");

  useEffect(() => {
    const task = window.setTimeout(() => setHeaderActionsTarget(headerActionsTargetId ? document.getElementById(headerActionsTargetId) : null), 0);
    return () => window.clearTimeout(task);
  }, [headerActionsTargetId]);

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
  const presentedEvents = useMemo(() => events.map((event) => ({ event, details: presentAuditEvent(event) })), [events]);
  const visibleEvents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    return presentedEvents.filter(({ event, details }) => {
      if (category !== "all" && event.category !== category) return false;
      if (!query) return true;
      return [event.actorName, details.searchText, event.siteName, CATEGORY_LABELS[event.category] ?? "Другой раздел"]
        .some((value) => value.toLocaleLowerCase("ru-RU").includes(query));
    });
  }, [category, presentedEvents, search]);

  const navigate = async (target: AuditNavigationTarget) => {
    if (!onNavigate || !canNavigate?.(target) || navigating) return;
    setNavigating(true);
    setNavigationError("");
    try { await onNavigate(target); }
    catch { setNavigationError("Не удалось открыть связанный раздел. Попробуйте ещё раз."); }
    finally { setNavigating(false); }
  };

  const headerActions = <div className="audit-log-toolbar-actions">
    <span className="audit-log-count" aria-live="polite">{visibleEvents.length} событий</span>
    <button type="button" className="back-button" onClick={() => void loadEvents()} disabled={loading}>{loading ? "Обновляем…" : "Обновить"}</button>
  </div>;

  return <section className="audit-log-page">
    {headerActionsTargetId ? headerActionsTarget && createPortal(headerActions, headerActionsTarget) : <div className="settings-toolbar audit-log-toolbar">
      <button type="button" className="back-button" onClick={onBack}>← К общим настройкам</button>
      {headerActions}
    </div>}
    <div className="audit-log-filters">
      <label className="audit-log-filter-field"><span>Поиск</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Сотрудник, действие, проект или подробности" /></label>
      <div className="audit-log-filter-field"><span>Раздел</span><CustomSelect className="audit-log-category-select" value={category} ariaLabel="Раздел журнала" onChange={setCategory} options={[{ value: "all", label: "Все разделы" }, ...categories.map((value) => ({ value, label: CATEGORY_LABELS[value] ?? "Другой раздел" }))]} /></div>
    </div>
    {navigationError && <div className="message error inline-message" role="alert">{navigationError}</div>}
    {error && <div className="message error inline-message"><strong>Не удалось загрузить журнал</strong><span>{error}</span></div>}
    {!error && loading && <div className="audit-log-empty">Загружаем историю действий…</div>}
    {!error && !loading && !visibleEvents.length && <div className="audit-log-empty"><strong>{events.length ? "Ничего не найдено" : "Записей пока нет"}</strong><span>{events.length ? "Попробуйте изменить поиск или выбрать другой раздел." : "Новые изменения появятся здесь после сохранения отчёта, табеля или настроек."}</span></div>}
    {!error && !loading && Boolean(visibleEvents.length) && <div className="audit-log-list">{visibleEvents.map(({ event, details }) => {
      const isExpanded = expanded.has(event.id);
      const links = onNavigate && canNavigate ? details.links.filter((link) => canNavigate(link.target)) : [];
      return <article className="audit-log-event" key={event.id}>
        <div className={`audit-log-marker ${event.category}`} aria-hidden="true" />
        <div className="audit-log-main">
          <div className="audit-log-event-heading"><div><strong>{details.title}</strong><span>{event.actorName || "Пользователь не указан"}{event.actorRole && ` · ${isUserRole(event.actorRole) ? ROLE_LABELS[event.actorRole] : event.actorRole}`}</span></div><time dateTime={event.createdAt}>{eventTime(event.createdAt)}</time></div>
          <div className="audit-log-meta"><span>{CATEGORY_LABELS[event.category] ?? "Другой раздел"}</span>{event.siteName && <span>{event.siteName}</span>}</div>
          <button type="button" className="audit-log-details-button" aria-expanded={isExpanded} aria-controls={`audit-details-${event.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(event.id)) next.delete(event.id); else next.add(event.id); return next; })}>{isExpanded ? "Скрыть подробности" : "Показать подробности"}<span aria-hidden="true"> {isExpanded ? "⌃" : "⌄"}</span></button>
          {isExpanded && <AuditEventDetails eventId={event.id} details={details} links={links} navigating={navigating} onNavigate={navigate} />}
        </div>
      </article>;
    })}</div>}
  </section>;
}
