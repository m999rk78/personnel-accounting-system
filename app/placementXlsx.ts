type CellValue = string | number;

export type PlacementExportRow = {
  workDate: string;
  employeeName: string;
  employmentType: string;
  department: string;
  positionSnapshot: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  masterName: string;
  hours: number;
  note: string;
};

export type PlacementTemplateData = {
  employees: Array<{ fullName: string; employmentType: string; department: string; position: string }>;
  shifts: string[];
  zones: string[];
  mainWorkTypes: string[];
  subworkTypes: string[];
  masters: string[];
};

export type PlacementImportRow = {
  employeeName: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  masterName: string;
  hours: string;
  note: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const headers = ["Дата", "ФИО", "Тип", "Отдел", "Должность", "Смена", "Зона", "Основная работа", "Вид подработ", "Мастер", "Часы", "Примечание"];
const letters = "ABCDEFGHIJKL";

function xml(value: CellValue) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function join(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function zip(files: Array<{ name: string; content: string }>) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const local = join([uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), name, content]);
    localParts.push(local);
    centralParts.push(join([uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), name]));
    offset += local.length;
  }
  const central = join(centralParts);
  return join([...localParts, central, join([uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length), uint32(central.length), uint32(offset), uint16(0)])]);
}

function cell(reference: string, value: CellValue, style = 0) {
  if (typeof value === "number") return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function workbookFiles(sheet1: string, sheet2?: string, sheet1Name = "Расстановка", sheet2Name = "Справочники") {
  const hasReferences = Boolean(sheet2);
  const sheetOverride = hasReferences ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : "";
  const secondSheet = hasReferences ? `<sheet name="${xml(sheet2Name)}" sheetId="2" r:id="rId2"/>` : "";
  const secondRelationship = hasReferences ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' : "";
  const styleId = hasReferences ? "rId3" : "rId2";
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${sheetOverride}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet1Name)}" sheetId="1" r:id="rId1"/>${secondSheet}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${secondRelationship}<Relationship Id="${styleId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="16"/><color rgb="FF24272A"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FF24272A"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2AD24"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9D9D6"/></left><right style="thin"><color rgb="FFD9D9D6"/></right><top style="thin"><color rgb="FFD9D9D6"/></top><bottom style="thin"><color rgb="FFD9D9D6"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>' },
    { name: "xl/worksheets/sheet1.xml", content: sheet1 },
  ];
  if (sheet2) files.push({ name: "xl/worksheets/sheet2.xml", content: sheet2 });
  return files;
}

function downloadBlob(bytes: Uint8Array) {
  return new Blob([bytes.slice().buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function createPlacementXlsx(siteName: string, workDate: string, rows: PlacementExportRow[]) {
  const dataRows = rows.map((row, index) => {
    const values: CellValue[] = [row.workDate, row.employeeName, row.employmentType, row.department, row.positionSnapshot, row.shiftName, row.zoneName, row.mainWorkTypeName, row.subworkTypeName, row.masterName, row.hours, row.note];
    const rowNumber = index + 5;
    return `<row r="${rowNumber}" ht="24">${values.map((value, column) => cell(`${letters[column]}${rowNumber}`, value, column === 10 ? 3 : 0)).join("")}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="4" width="13" customWidth="1"/><col min="5" max="5" width="34" customWidth="1"/><col min="6" max="7" width="18" customWidth="1"/><col min="8" max="10" width="30" customWidth="1"/><col min="11" max="11" width="10" customWidth="1"/><col min="12" max="12" width="28" customWidth="1"/></cols><sheetData><row r="1" ht="34">${cell("A1", `Отчёт персонала — ${siteName}`, 1)}</row><row r="2" ht="22">${cell("A2", `Рабочий день: ${workDate}`, 0)}</row><row r="4" ht="30">${headers.map((header, index) => cell(`${letters[index]}4`, header, 2)).join("")}</row>${dataRows}</sheetData><autoFilter ref="A4:L${Math.max(4, rows.length + 4)}"/><mergeCells count="2"><mergeCell ref="A1:L1"/><mergeCell ref="A2:L2"/></mergeCells></worksheet>`;
  return downloadBlob(zip(workbookFiles(worksheet)));
}

export function createPlacementTemplateXlsx(siteName: string, workDate: string, data: PlacementTemplateData) {
  const blankRows = Array.from({ length: 100 }, (_, index) => {
    const rowNumber = index + 5;
    return `<row r="${rowNumber}" ht="24">${cell(`A${rowNumber}`, workDate)}${Array.from({ length: 11 }, (__, column) => cell(`${letters[column + 1]}${rowNumber}`, "")).join("")}</row>`;
  }).join("");
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="4" width="13" customWidth="1"/><col min="5" max="5" width="34" customWidth="1"/><col min="6" max="7" width="18" customWidth="1"/><col min="8" max="10" width="30" customWidth="1"/><col min="11" max="11" width="10" customWidth="1"/><col min="12" max="12" width="28" customWidth="1"/></cols><sheetData><row r="1" ht="34">${cell("A1", `Шаблон отчёта персонала — ${siteName}`, 1)}</row><row r="2" ht="22">${cell("A2", "Заполняйте белые строки. Тип, отдел и должность можно не вводить — система подставит их по ФИО.", 0)}</row><row r="4" ht="30">${headers.map((header, index) => cell(`${letters[index]}4`, header, 2)).join("")}</row>${blankRows}</sheetData><autoFilter ref="A4:L104"/><mergeCells count="2"><mergeCell ref="A1:L1"/><mergeCell ref="A2:L2"/></mergeCells></worksheet>`;
  const referenceRows = Math.max(data.employees.length, data.shifts.length, data.zones.length, data.mainWorkTypes.length, data.subworkTypes.length, data.masters.length);
  const references = Array.from({ length: referenceRows }, (_, index) => `<row r="${index + 2}">${cell(`A${index + 2}`, data.employees[index]?.fullName ?? "")}${cell(`B${index + 2}`, data.employees[index]?.employmentType ?? "")}${cell(`C${index + 2}`, data.employees[index]?.department ?? "")}${cell(`D${index + 2}`, data.employees[index]?.position ?? "")}${cell(`E${index + 2}`, data.shifts[index] ?? "")}${cell(`F${index + 2}`, data.zones[index] ?? "")}${cell(`G${index + 2}`, data.mainWorkTypes[index] ?? "")}${cell(`H${index + 2}`, data.subworkTypes[index] ?? "")}${cell(`I${index + 2}`, data.masters[index] ?? "")}</row>`).join("");
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="3" width="14" customWidth="1"/><col min="4" max="4" width="34" customWidth="1"/><col min="5" max="6" width="22" customWidth="1"/><col min="7" max="9" width="34" customWidth="1"/></cols><sheetData><row r="1">${["ФИО", "Тип", "Отдел", "Должность", "Смена", "Зона", "Основная работа", "Вид подработ", "Мастер"].map((header, index) => cell(`${"ABCDEFGHI"[index]}1`, header, 2)).join("")}</row>${references}</sheetData><autoFilter ref="A1:I${Math.max(2, referenceRows + 1)}"/></worksheet>`;
  return downloadBlob(zip(workbookFiles(sheet1, sheet2)));
}

export function createTableXlsx(sheetName: string, title: string, tableHeaders: string[], rows: CellValue[][]) {
  if (tableHeaders.length > letters.length) throw new Error("Слишком много столбцов для экспорта.");
  const lastLetter = letters[tableHeaders.length - 1];
  const dataRows = rows.map((values, index) => {
    const rowNumber = index + 4;
    return `<row r="${rowNumber}" ht="24">${values.map((value, column) => cell(`${letters[column]}${rowNumber}`, value)).join("")}</row>`;
  }).join("");
  const columns = tableHeaders.map((_, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 36 : 24}" customWidth="1"/>`).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData><row r="1" ht="34">${cell("A1", title, 1)}</row><row r="3" ht="30">${tableHeaders.map((header, index) => cell(`${letters[index]}3`, header, 2)).join("")}</row>${dataRows}</sheetData><autoFilter ref="A3:${lastLetter}${Math.max(3, rows.length + 3)}"/><mergeCells count="1"><mergeCell ref="A1:${lastLetter}1"/></mergeCells></worksheet>`;
  return downloadBlob(zip(workbookFiles(worksheet, undefined, sheetName)));
}

async function unzipEntry(buffer: ArrayBuffer, targetName: string) {
  const view = new DataView(buffer);
  let eocd = buffer.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("Файл не является корректным XLSX.");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
    if (name === targetName) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const bytes = new Uint8Array(buffer, dataOffset, compressedSize);
      if (method === 0) return decoder.decode(bytes);
      if (method !== 8) throw new Error("Этот способ сжатия XLSX пока не поддерживается.");
      const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
      return decoder.decode(await new Response(stream).arrayBuffer());
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function normalizeHeader(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
}

export async function parseTableXlsx(file: File, requiredHeaders: string[]) {
  const buffer = await file.arrayBuffer();
  const worksheetXml = await unzipEntry(buffer, "xl/worksheets/sheet1.xml");
  if (!worksheetXml) throw new Error("В файле нет первого листа.");
  const sharedXml = await unzipEntry(buffer, "xl/sharedStrings.xml");
  const parser = new DOMParser();
  const shared = sharedXml ? Array.from(parser.parseFromString(sharedXml, "application/xml").getElementsByTagName("si")).map((node) => node.textContent ?? "") : [];
  const document = parser.parseFromString(worksheetXml, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("Не удалось прочитать структуру XLSX.");
  const parsedRows = Array.from(document.getElementsByTagName("row")).map((row) => {
    const values = new Map<number, string>();
    for (const cellNode of Array.from(row.getElementsByTagName("c"))) {
      const ref = cellNode.getAttribute("r") ?? "A1";
      const lettersOnly = ref.match(/[A-Z]+/)?.[0] ?? "A";
      let column = 0;
      for (const character of lettersOnly) column = column * 26 + character.charCodeAt(0) - 64;
      const type = cellNode.getAttribute("t");
      const raw = type === "inlineStr" ? cellNode.getElementsByTagName("is")[0]?.textContent ?? "" : cellNode.getElementsByTagName("v")[0]?.textContent ?? "";
      values.set(column - 1, type === "s" ? shared[Number(raw)] ?? "" : raw);
    }
    return values;
  });
  const normalizedRequired = requiredHeaders.map(normalizeHeader);
  const headerIndex = parsedRows.findIndex((row) => normalizedRequired.every((header) => Array.from(row.values()).some((value) => normalizeHeader(value) === header)));
  if (headerIndex < 0) throw new Error(`Не найдены обязательные столбцы: ${requiredHeaders.join(", ")}.`);
  const headerMap = new Map<string, number>();
  parsedRows[headerIndex].forEach((value, column) => headerMap.set(normalizeHeader(value), column));
  return parsedRows.slice(headerIndex + 1).map((row) => Object.fromEntries(requiredHeaders.map((header) => [header, row.get(headerMap.get(normalizeHeader(header))!)?.trim() ?? ""]))).filter((row) => Object.values(row).some(Boolean));
}

export async function parsePlacementXlsx(file: File): Promise<PlacementImportRow[]> {
  const buffer = await file.arrayBuffer();
  const worksheetXml = await unzipEntry(buffer, "xl/worksheets/sheet1.xml");
  if (!worksheetXml) throw new Error("В файле нет листа с расстановкой.");
  const sharedXml = await unzipEntry(buffer, "xl/sharedStrings.xml");
  const parser = new DOMParser();
  const shared = sharedXml ? Array.from(parser.parseFromString(sharedXml, "application/xml").getElementsByTagName("si")).map((node) => node.textContent ?? "") : [];
  const document = parser.parseFromString(worksheetXml, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("Не удалось прочитать структуру XLSX.");
  const parsedRows = Array.from(document.getElementsByTagName("row")).map((row) => {
    const values = new Map<number, string>();
    for (const cellNode of Array.from(row.getElementsByTagName("c"))) {
      const ref = cellNode.getAttribute("r") ?? "A1";
      const lettersOnly = ref.match(/[A-Z]+/)?.[0] ?? "A";
      let column = 0;
      for (const character of lettersOnly) column = column * 26 + character.charCodeAt(0) - 64;
      const type = cellNode.getAttribute("t");
      const raw = type === "inlineStr" ? cellNode.getElementsByTagName("is")[0]?.textContent ?? "" : cellNode.getElementsByTagName("v")[0]?.textContent ?? "";
      values.set(column - 1, type === "s" ? shared[Number(raw)] ?? "" : raw);
    }
    return values;
  });
  const headerIndex = parsedRows.findIndex((row) => Array.from(row.values()).some((value) => normalizeHeader(value) === "фио"));
  if (headerIndex < 0) throw new Error("Не найдена строка заголовков. Используйте скачанный шаблон.");
  const headerMap = new Map<string, number>();
  parsedRows[headerIndex].forEach((value, column) => headerMap.set(normalizeHeader(value), column));
  const column = (...names: string[]) => names.map(normalizeHeader).map((name) => headerMap.get(name)).find((value) => value !== undefined);
  const employeeColumn = column("ФИО");
  const shiftColumn = column("Смена");
  const zoneColumn = column("Зона");
  const mainColumn = column("Основная работа", "Виды основных работ");
  const subworkColumn = column("Вид подработ", "Виды подработ");
  const masterColumn = column("Мастер");
  const hoursColumn = column("Часы");
  const noteColumn = column("Примечание");
  if ([employeeColumn, shiftColumn, zoneColumn, mainColumn, subworkColumn, masterColumn, hoursColumn].some((value) => value === undefined)) throw new Error("В XLSX отсутствуют обязательные столбцы. Используйте скачанный шаблон.");
  return parsedRows.slice(headerIndex + 1).map((row) => ({
    employeeName: row.get(employeeColumn!)?.trim() ?? "",
    shiftName: row.get(shiftColumn!)?.trim() ?? "",
    zoneName: row.get(zoneColumn!)?.trim() ?? "",
    mainWorkTypeName: row.get(mainColumn!)?.trim() ?? "",
    subworkTypeName: row.get(subworkColumn!)?.trim() ?? "",
    masterName: row.get(masterColumn!)?.trim() ?? "",
    hours: row.get(hoursColumn!)?.trim() ?? "",
    note: noteColumn === undefined ? "" : row.get(noteColumn)?.trim() ?? "",
  })).filter((row) => Object.values(row).some(Boolean));
}
