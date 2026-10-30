"use client";

import { createContext, useContext } from "react";
import type { workspaceTableAccess } from "./workspaceAccess";

type TableAccess = ReturnType<typeof workspaceTableAccess>;
const WorkspaceAccessContext = createContext<TableAccess | null>(null);

export function WorkspaceAccessProvider({ access, children }: { access: TableAccess; children: React.ReactNode }) {
  return <WorkspaceAccessContext.Provider value={access}>{children}</WorkspaceAccessContext.Provider>;
}

/** No provider means a standalone table, whose explicit capability props still apply. */
export const useWorkspaceAccess = () => useContext(WorkspaceAccessContext);
