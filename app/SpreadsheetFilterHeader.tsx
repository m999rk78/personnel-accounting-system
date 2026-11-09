"use client";

import { useEffect, useState } from "react";
import type { CustomInnerHeaderProps } from "ag-grid-react";
import { ColumnFilterIcon } from "./ColumnFilterIcon";
import { useColumnFilterToggle } from "./useColumnFilterToggle";

export function SpreadsheetFilterHeader(props: CustomInnerHeaderProps) {
  const [active, setActive] = useState(() => props.column.isFilterActive());
  const { open, buttonProps } = useColumnFilterToggle(props);
  useEffect(() => {
    const update = () => setActive(props.column.isFilterActive());
    props.api.addEventListener("filterChanged", update);
    return () => {
      if (!props.api.isDestroyed()) props.api.removeEventListener("filterChanged", update);
    };
  }, [props.api, props.column]);
  return <span className="ag-pinnable-header"><span>{props.displayName}</span><span className="ag-header-tools"><button type="button" className={active ? "ag-column-filter active" : "ag-column-filter"} aria-label={`Фильтр: ${props.displayName}`} aria-expanded={open} aria-haspopup="dialog" title={`Фильтр: ${props.displayName}`}
    {...buttonProps}><ColumnFilterIcon /></button></span></span>;
}
