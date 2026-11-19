import { themeQuartz } from "ag-grid-community";

// Set to "legacy" to keep the original blue editable rows in approved reports.
export const approvedReportRowTone: "warm" | "legacy" = "warm";

export const gridTheme = themeQuartz.withParams({
  accentColor: "#f2aa00",
  backgroundColor: "#ffffff",
  borderColor: "#dedede",
  browserColorScheme: "light",
  cellHorizontalPadding: 12,
  cellEditingBorder: false,
  cellEditingShadow: false,
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontSize: 13,
  foregroundColor: "#27272a",
  headerBackgroundColor: "#fafafa",
  headerFontSize: 13,
  headerFontWeight: 650,
  headerTextColor: "#27272a",
  rowBorder: { color: "#dedede", width: 1 },
  rowHoverColor: "#f8fbff",
  selectedRowBackgroundColor: "#fff7df",
  spacing: 6,
});
