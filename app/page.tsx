import type { Metadata } from "next";
import { headers } from "next/headers";
import AuthGate from "./AuthGate";

export const metadata: Metadata = {
  title: "Расстановка | Учёт персонала",
  description: "Ежедневный учёт работ и часов сотрудников на строительных объектах.",
};

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

export default async function Home() {
  await headers();
  return <AuthGate initialToday={currentDateInProjectTimezone()} />;
}
