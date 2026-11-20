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

/** Excel can use the HTML table to keep literal labels and numeric cells intact. */
export function spreadsheetClipboardHtml(text: string, numericColumns?: readonly boolean[]): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const rows = parseSpreadsheetText(text).map(row => "<tr>" + row.map((value, index) => {
    const numeric = numericColumns?.[index] !== false && /^-?(?:0|[1-9]\d*)(?:[.,]\d+)?$/.test(value) && Number.isFinite(Number(value.replace(",", ".")));
    const attributes = numeric
      ? ` x:num="${value.replace(",", ".")}"`
      : ' style="mso-number-format:&quot;\\@&quot;"';
    return `<td${attributes}>${escape(value).replace(/\r\n|\r|\n/g, '<br style="mso-data-placement:same-cell">')}</td>`;
  }).join("") + "</tr>").join("");
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table>${rows}</table></body></html>`;
}

/** Strip only our complete, exact header row when actual data follows it. */
export function stripSpreadsheetHeaderRow(rows: string[][], headers: string[]) {
  return rows.length > 1 && headers.length > 0 && rows[0].length === headers.length
    && headers.every((header, index) => rows[0][index] === header) ? rows.slice(1) : rows;
}
