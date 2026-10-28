import type { Metadata } from "next";
import { ExcelExportPreviewPage } from "../ExcelExportPreview";

export const metadata: Metadata = {
  title: "Ресурсный отчёт | Предпросмотр Excel",
  description: "Предпросмотр данных перед экспортом в Excel.",
};

export default function ExcelPreviewPage() {
  return <ExcelExportPreviewPage />;
}
