/** Excel/Sheets TSV supports quoted tabs, line breaks and doubled quotes. */
export function parseSpreadsheetText(text: string): string[][] {
  const rows: string[][] = [[]];
  let value = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && (quoted || value === "")) {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "\t" || char === "\n" || char === "\r")) {
      rows.at(-1)!.push(value); value = "";
      if (char !== "\t") {
        if (char === "\r" && text[index + 1] === "\n") index++;
        rows.push([]);
      }
    } else value += char;
  }
  rows.at(-1)!.push(value);
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "" && /[\r\n]$/.test(text)) rows.pop();
  return rows;
}

export function serializeSpreadsheetText(rows: string[][]): string {
  return rows.map(row => row.map(value => /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join("\t")).join("\n");
}

/** Strip only our complete, exact header row when actual data follows it. */
export function stripSpreadsheetHeaderRow(rows: string[][], headers: string[]) {
  return rows.length > 1 && headers.length > 0 && rows[0].length === headers.length
    && headers.every((header, index) => rows[0][index] === header) ? rows.slice(1) : rows;
}
