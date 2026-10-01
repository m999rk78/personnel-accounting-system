"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Position = { top: number; left: number };

export function TimesheetCellPopover({ anchor, width = 300, ariaLabel, className = "", onClose, children }: {
  anchor: HTMLElement;
  width?: number;
  ariaLabel: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>(() => ({ top: anchor.getBoundingClientRect().bottom + 5, left: anchor.getBoundingClientRect().left }));

  const updatePosition = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const popoverHeight = root.current?.offsetHeight ?? 280;
    const padding = 8;
    const left = Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding));
    const roomBelow = window.innerHeight - rect.bottom - padding;
    const top = roomBelow >= Math.min(popoverHeight, 220)
      ? rect.bottom + 5
      : Math.max(padding, rect.top - popoverHeight - 5);
    setPosition({ top, left });
  }, [anchor, width]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.current?.contains(target) || anchor.contains(target)) return;
      if (target instanceof Element && target.closest(".custom-select-menu")) return;
      onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [anchor, onClose, updatePosition]);

  return createPortal(<div ref={root} className={["timesheet-cell-popover", className].filter(Boolean).join(" ")} role="dialog" aria-label={ariaLabel} style={{ top: position.top, left: position.left, width }}>{children}</div>, document.body);
}
