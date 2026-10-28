"use client";

import { AllCommunityModule } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";

const communityModules = [AllCommunityModule];
const enterpriseModules = [AllEnterpriseModule];

export function AgGridEnterpriseProvider({ children, licenseKey }: { children: React.ReactNode; licenseKey: string }) {
  const configuredLicenseKey = licenseKey.trim();
  return <AgGridProvider
    modules={configuredLicenseKey ? enterpriseModules : communityModules}
    {...(configuredLicenseKey ? { licenseKey: configuredLicenseKey } : {})}
  >{children}</AgGridProvider>;
}
