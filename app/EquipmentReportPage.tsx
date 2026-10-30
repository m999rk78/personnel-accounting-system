"use client";

import { useEffect, useState } from "react";
import type { GridEquipmentUnit, GridOption } from "./AgDataGrids";
import { EquipmentReportWorkspace, type EquipmentReportWorkspaceProps } from "./EquipmentReportWorkspace";

type Catalogs = {
  siteName: string;
  units: GridEquipmentUnit[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
};

type Props = Pick<EquipmentReportWorkspaceProps, "siteId" | "siteName" | "today" | "currentUser" | "permissions" | "onDirtyChange">;

export function EquipmentReportPage(props: Props) {
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const params = new URLSearchParams({ siteId: String(props.siteId), date: props.today, month: props.today.slice(0, 7), scope: "project", view: "daily", section: "daily" });
        const response = await fetch(`/api/equipment?${params}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { window.location.replace("/login"); return; }
        const result = await response.json() as Catalogs & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить справочники техники.");
        if (!controller.signal.aborted) { setCatalogs(result); setError(""); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Не удалось загрузить справочники техники.");
      }
    })();
    return () => controller.abort();
  }, [props.siteId, props.today, retry]);
  return <>
    {error && <div className="message error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>Повторить</button></div>}
    <EquipmentReportWorkspace {...props} siteName={catalogs?.siteName ?? props.siteName} units={catalogs?.units ?? []} shifts={catalogs?.shifts ?? []} zones={catalogs?.zones ?? []} mainWorkTypes={catalogs?.mainWorkTypes ?? []} subworkTypes={catalogs?.subworkTypes ?? []} loading={!catalogs || Boolean(error)} />
  </>;
}
