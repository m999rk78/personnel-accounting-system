import type { Metadata } from "next";
import PersonnelApp from "./PersonnelApp";

export const metadata: Metadata = {
  title: "Расстановка | Учёт персонала",
  description: "Ежедневный учёт работ и часов сотрудников на строительных объектах.",
};

export default function Home() {
  return <PersonnelApp />;
}
