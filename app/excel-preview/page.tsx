import type { Metadata } from "next";
import { ExcelExportPreviewPage } from "../ExcelExportPreview";

export const metadata: Metadata = {
  title: "Предпросмотр Excel | Учёт персонала",
  description: "Предпросмотр данных перед экспортом в Excel.",
};

export default function ExcelPreviewPage() {
  return <ExcelExportPreviewPage />;
}
