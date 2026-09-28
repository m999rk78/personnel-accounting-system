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
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
};

export function CustomSelect({ value, options, onChange, ariaLabel, className = "", disabled = false, autoOpen = false }: CustomSelectProps) {
  const listboxId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const autoOpened = useRef(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : options[0];
  const enabledIndexes = useMemo(() => options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0), [options]);

  const updatePosition = useCallback(() => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const viewportPadding = 8;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
    const desiredHeight = Math.min(288, options.length * 38 + 10);
    const roomBelow = window.innerHeight - rect.bottom - viewportPadding;
    const roomAbove = rect.top - viewportPadding;
    const placement = roomBelow < Math.min(desiredHeight, 180) && roomAbove > roomBelow ? "top" : "bottom";
    const maxHeight = Math.max(90, Math.min(desiredHeight, placement === "bottom" ? roomBelow - 6 : roomAbove - 6));
    const top = placement === "bottom" ? rect.bottom + 6 : Math.max(viewportPadding, rect.top - maxHeight - 6);
    setPosition({ top, left, width, maxHeight, placement });
  }, [options.length]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);

  const openMenu = useCallback((preferredIndex?: number) => {
    if (disabled || enabledIndexes.length === 0) return;
    const nextIndex = preferredIndex ?? (selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : enabledIndexes[0]);
    setActiveIndex(nextIndex);
    setOpen(true);
  }, [disabled, enabledIndexes, options, selectedIndex]);

  useEffect(() => {
    if (!autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    const frame = requestAnimationFrame(() => {
      trigger.current?.focus();
      openMenu();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoOpen, openMenu]);

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
    requestAnimationFrame(() => optionButtons.current[activeIndex]?.focus());
  }, [activeIndex, open, position]);

  function moveActive(direction: 1 | -1) {
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
    }
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
      id={listboxId}
      className="custom-select-menu"
      role="listbox"
      aria-label={ariaLabel}
      data-placement={position.placement}
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return <button
          ref={(element) => { optionButtons.current[index] = element; }}
          key={`${option.value}-${index}`}
          type="button"
          className={["custom-select-option", selected ? "selected" : "", activeIndex === index ? "active" : ""].filter(Boolean).join(" ")}
          role="option"
          aria-selected={selected}
          disabled={option.disabled}
          tabIndex={activeIndex === index ? 0 : -1}
          onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
          onKeyDown={handleOptionKeyDown}
          onClick={() => choose(option)}
        >
          <span>{option.label}</span>
          {selected && <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>}
        </button>;
      })}
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
