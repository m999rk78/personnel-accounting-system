"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type CustomSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type CustomSelectProps = {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  autoOpen?: boolean;
  searchable?: boolean;
  initialQuery?: string;
  requireExactQueryOnEnter?: boolean;
  onInvalidQuery?: (query: string) => void;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
};

const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

export function CustomSelect({ value, options, onChange, ariaLabel, className = "", disabled = false, autoOpen = false, searchable = false, initialQuery = "", requireExactQueryOnEnter = false, onInvalidQuery }: CustomSelectProps) {
  const listboxId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const autoOpened = useRef(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [query, setQuery] = useState("");
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : options[0];
  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    return options.map((option, index) => ({ option, index })).filter(({ option }) => !normalizedQuery || normalizeSearch(option.label).includes(normalizedQuery));
  }, [options, query]);
  const enabledIndexes = useMemo(() => filteredOptions.map(({ option, index }) => option.disabled ? -1 : index).filter((index) => index >= 0), [filteredOptions]);

  const updatePosition = useCallback(() => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const viewportPadding = 8;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
    const desiredHeight = Math.min(340, filteredOptions.length * 38 + (searchable ? 54 : 10));
    const roomBelow = window.innerHeight - rect.bottom - viewportPadding;
    const roomAbove = rect.top - viewportPadding;
    const placement = roomBelow < Math.min(desiredHeight, 180) && roomAbove > roomBelow ? "top" : "bottom";
    const maxHeight = Math.max(90, Math.min(desiredHeight, placement === "bottom" ? roomBelow - 6 : roomAbove - 6));
    const top = placement === "bottom" ? rect.bottom + 6 : Math.max(viewportPadding, rect.top - maxHeight - 6);
    setPosition({ top, left, width, maxHeight, placement });
  }, [filteredOptions.length, searchable]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);

  const openMenu = useCallback((preferredIndex?: number, initialQuery = "") => {
    if (disabled || options.every((option) => option.disabled)) return;
    const normalizedInitialQuery = normalizeSearch(initialQuery);
    const initialEnabledIndexes = options.map((option, index) => option.disabled || (normalizedInitialQuery && !normalizeSearch(option.label).includes(normalizedInitialQuery)) ? -1 : index).filter((index) => index >= 0);
    const nextIndex = preferredIndex ?? (initialQuery ? initialEnabledIndexes[0] : selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : initialEnabledIndexes[0]);
    setQuery(initialQuery);
    setActiveIndex(nextIndex ?? -1);
    setOpen(true);
  }, [disabled, options, selectedIndex]);

  useEffect(() => {
    if (!autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    const frame = requestAnimationFrame(() => {
      trigger.current?.focus();
      openMenu(undefined, initialQuery);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoOpen, initialQuery, openMenu]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    const handleViewportChange = () => updatePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    if (!open || !position) return;
    requestAnimationFrame(() => {
      if (searchable) {
        searchInput.current?.focus();
        optionButtons.current[activeIndex]?.scrollIntoView({ block: "nearest" });
      } else optionButtons.current[activeIndex]?.focus();
    });
  }, [activeIndex, open, position, searchable]);

  function moveActive(direction: 1 | -1) {
    if (!enabledIndexes.length) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next = current < 0 ? 0 : (current + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  }

  function choose(option: CustomSelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" ? enabledIndexes.at(-1) : undefined);
    } else if (searchable && event.key.length === 1 && event.key.trim() && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      openMenu(undefined, event.key);
    }
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (enabledIndexes.length) setActiveIndex(event.key === "Home" ? enabledIndexes[0] : enabledIndexes.at(-1)!);
    } else if (event.key === "Enter" && requireExactQueryOnEnter && query.trim()) {
      event.preventDefault();
      const normalizedQuery = normalizeSearch(query);
      const exactOption = options.find((option) => !option.disabled && normalizeSearch(option.value) === normalizedQuery);
      if (exactOption) choose(exactOption);
      else onInvalidQuery?.(query);
    } else if (event.key === "Enter" && activeIndex >= 0 && options[activeIndex]) {
      event.preventDefault();
      choose(options[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close();
  }

  function handleOptionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? enabledIndexes[0] : enabledIndexes.at(-1)!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  }

  const popup = open && position ? createPortal(
    <div
      ref={menu}
      className="custom-select-menu"
      data-placement={position.placement}
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
    >
      {searchable && <label className="custom-select-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        <input
          ref={searchInput}
          type="text"
          role="searchbox"
          aria-label={`Поиск: ${ariaLabel}`}
          placeholder={`Поиск: ${ariaLabel.toLocaleLowerCase("ru-RU")}`}
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            const normalizedQuery = normalizeSearch(nextQuery);
            const firstMatch = options.findIndex((option) => !option.disabled && (!normalizedQuery || normalizeSearch(option.label).includes(normalizedQuery)));
            setQuery(nextQuery);
            setActiveIndex(firstMatch);
          }}
          onKeyDown={handleSearchKeyDown}
        />
      </label>}
      <div id={listboxId} className="custom-select-options" role="listbox" aria-label={ariaLabel}>
      {filteredOptions.map(({ option, index }) => {
        const selected = option.value === value;
        return <button
          ref={(element) => { optionButtons.current[index] = element; }}
          key={`${option.value}-${index}`}
          type="button"
          className={["custom-select-option", selected ? "selected" : "", activeIndex === index ? "active" : ""].filter(Boolean).join(" ")}
          role="option"
          aria-selected={selected}
          disabled={option.disabled}
          tabIndex={!searchable && activeIndex === index ? 0 : -1}
          onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
          onKeyDown={handleOptionKeyDown}
          onClick={() => choose(option)}
        >
          <span>{option.label}</span>
          {selected && <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>}
        </button>;
      })}
      {!filteredOptions.length && <div className="custom-select-empty">Ничего не найдено</div>}
      </div>
    </div>,
    document.body,
  ) : null;

  return <div className={["custom-select", className].filter(Boolean).join(" ")} ref={root}>
    <button
      ref={trigger}
      type="button"
      className="custom-select-toggle"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-controls={listboxId}
      aria-expanded={open}
      disabled={disabled}
      onKeyDown={handleTriggerKeyDown}
      onClick={() => open ? close() : openMenu()}
    >
      <span className="custom-select-value">{selectedOption?.label ?? "—"}</span>
      <svg className="custom-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>
    </button>
    {popup}
  </div>;
}
