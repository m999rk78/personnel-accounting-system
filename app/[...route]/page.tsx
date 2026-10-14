import type { Metadata } from "next";
import { headers } from "next/headers";
import AuthGate from "../AuthGate";
import { parseWorkspaceLocation, workspaceTitle } from "../appRoutes";
import { getAuthUser } from "../auth";

const description = "Ежедневный учёт работ, сотрудников и техники на строительных объектах.";
type WorkspaceRouteProps = { params: Promise<{ route?: string[] }> };

export async function generateMetadata({ params }: WorkspaceRouteProps): Promise<Metadata> {
  const route = (await params).route ?? [];
  const location = parseWorkspaceLocation(`/${route.join("/")}`, "", "2026-01-01");
  const title = location.recognized ? `${workspaceTitle(location.view, location.directoryFocus)} | Учёт персонала` : "Учёт персонала";
  return { title, description };
}

function currentDateInProjectTimezone() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default async function WorkspaceRoute() {
  const requestHeaders = await headers();
  const initialUser = process.env.DATABASE_URL || process.env.PGHOST
    ? await getAuthUser(new Request("http://localhost/", { headers: requestHeaders }))
    : undefined;
  return <AuthGate initialToday={currentDateInProjectTimezone()} initialUser={initialUser} />;
}
