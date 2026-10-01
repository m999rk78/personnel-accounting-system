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

export type EquipmentRegistryImportRow = {
  organization: string;
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
  projectName?: string;
  note: string;
};

export type EquipmentEntryImportRow = {
  workDate: string;
  equipmentName: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  note: string;
  hours: string;
};

export type PersonnelTimesheetExportRow = {
  employmentType: string;
  department: string;
  fullName: string;
  position: string;
  positionNote: string;
  dailyValues: CellValue[];
  timesheetHours: number;
  reportHours: number;
  masters: string;
};

export type EquipmentTimesheetExportRow = {
  equipmentName: string;
  organization: string;
  dailyValues: CellValue[];
  productiveHours: number;
  downtimeHours: number;
  totalHours: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const headers = ["Дата", "ФИО", "Тип", "Отдел", "Должность", "Смена", "Зона", "Основная работа", "Вид подработ", "Мастер", "Часы", "Примечание"];
const letters = "ABCDEFGHIJKL";

function columnLetter(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cellXmlColumnIndex(value: string) {
  const lettersOnly = value.match(/<c r="([A-Z]+)\d+"/)?.[1] ?? "A";
  return [...lettersOnly].reduce((result, character) => result * 26 + character.charCodeAt(0) - 64, 0);
}

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

function formulaCell(reference: string, formula: string, cachedValue: number, style = 0) {
  return `<c r="${reference}" s="${style}"><f>${xml(formula.replace(/^=/, ""))}</f><v>${cachedValue}</v></c>`;
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
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet1Name)}" sheetId="1" r:id="rId1"/>${secondSheet}</sheets><calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${secondRelationship}<Relationship Id="${styleId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd"/></numFmts><fonts count="7"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="16"/><color rgb="FF24272A"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FF24272A"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FF173E27"/><name val="Aptos"/></font><font><sz val="10"/><color rgb="FF24272A"/><name val="Aptos"/></font><font><b/><sz val="10"/><color rgb="FF24272A"/><name val="Aptos"/></font><font><b/><sz val="10"/><color rgb="FFC00000"/><name val="Aptos"/></font></fonts><fills count="9"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2AD24"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7FBF7"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE8E6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="4"><border/><border><left style="thin"><color rgb="FFD9D9D6"/></left><right style="thin"><color rgb="FFD9D9D6"/></right><top style="thin"><color rgb="FFD9D9D6"/></top><bottom style="thin"><color rgb="FFD9D9D6"/></bottom></border><border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right><top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom></border><border><left style="medium"><color rgb="FF7F7F7F"/></left><right style="medium"><color rgb="FF7F7F7F"/></right><top style="medium"><color rgb="FF7F7F7F"/></top><bottom style="medium"><color rgb="FF7F7F7F"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="16"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="3" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="3" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="4" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="6" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="7" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="8" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="7" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="7" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="8" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>' },
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

export function createTableXlsx(sheetName: string, title: string, tableHeaders: string[], rows: CellValue[][], columnWidths?: number[]) {
  const lastLetter = columnLetter(tableHeaders.length - 1);
  const dataRows = rows.map((values, index) => {
    const rowNumber = index + 4;
    return `<row r="${rowNumber}" ht="24">${values.map((value, column) => cell(`${columnLetter(column)}${rowNumber}`, value)).join("")}</row>`;
  }).join("");
  const columns = tableHeaders.map((_, index) => `<col min="${index + 1}" max="${index + 1}" width="${columnWidths?.[index] ?? (index === 0 ? 36 : 24)}" customWidth="1"/>`).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData><row r="1" ht="34">${cell("A1", title, 1)}</row><row r="3" ht="30">${tableHeaders.map((header, index) => cell(`${columnLetter(index)}3`, header, 2)).join("")}</row>${dataRows}</sheetData><autoFilter ref="A3:${lastLetter}${Math.max(3, rows.length + 3)}"/><mergeCells count="1"><mergeCell ref="A1:${lastLetter}1"/></mergeCells></worksheet>`;
  return downloadBlob(zip(workbookFiles(worksheet, undefined, sheetName)));
}

function excelDateSerial(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000) + 25569;
}

export function createPersonnelTimesheetXlsx(siteName: string, monthLabel: string, dates: string[], rows: PersonnelTimesheetExportRow[], dayTotals: number[], totalHours: number, totalDifference: number) {
  const dayStartColumn = 6;
  const dayColumnCount = 31;
  const hoursColumn = dayStartColumn + dayColumnCount;
  const differenceColumn = hoursColumn + 1;
  const masterColumn = differenceColumn + 1;
  const reportHoursColumn = 46;
  const headers = ["Тип", "Отдел", "Фамилия, имя, отчество", "Должность", "Примечание к должности"];
  const headerCells = headers.map((header, index) => cell(`${columnLetter(index + 1)}2`, header, 4)).join("");
  const dateCells = Array.from({ length: dayColumnCount }, (_, index) => dates[index]
    ? cell(`${columnLetter(dayStartColumn + index)}2`, excelDateSerial(dates[index]), 5)
    : cell(`${columnLetter(dayStartColumn + index)}2`, "", 5)).join("");
  const summaryHeaders = [
    cell(`${columnLetter(hoursColumn)}2`, "ЧАСЫ", 4),
    cell(`${columnLetter(differenceColumn)}2`, "РАСТ", 4),
    cell(`${columnLetter(masterColumn)}2`, "Мастер", 4),
    cell("AP2", "Проверка", 4),
    cell("AQ2", "Сумма", 4),
    cell("AS2", "Нач", 4),
    cell("AT2", "Кон", 4),
  ].join("");
  const firstDataRow = 3;
  const lastDataRow = rows.length + 2;
  const sumDataColumn = (column: string) => rows.length ? `SUM(${column}${firstDataRow}:${column}${lastDataRow})` : "0";
  const rowCells = new Map<number, string[]>();
  const rowHeights = new Map<number, number>([[1, 10.5], [2, 32]]);
  const addRowCells = (rowNumber: number, value: string) => rowCells.set(rowNumber, [...(rowCells.get(rowNumber) ?? []), value]);
  addRowCells(2, `${headerCells}${dateCells}${summaryHeaders}`);
  const dataRows = rows.map((row, index) => {
    const rowNumber = index + firstDataRow;
    const identityValues: CellValue[] = [row.employmentType, row.department, row.fullName, row.position, row.positionNote];
    const identityCells = identityValues.map((value, column) => cell(`${columnLetter(column + 1)}${rowNumber}`, value, 7)).join("");
    const dailyCells = Array.from({ length: dayColumnCount }, (_, dayIndex) => {
      const date = dates[dayIndex];
      const dayOfWeek = date ? new Date(`${date}T00:00:00Z`).getUTCDay() : -1;
      return cell(`${columnLetter(dayStartColumn + dayIndex)}${rowNumber}`, row.dailyValues[dayIndex] ?? "", dayOfWeek === 0 || dayOfWeek === 6 ? 9 : 8);
    }).join("");
    const compareWithReport = row.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР";
    const difference = compareWithReport ? row.timesheetHours - row.reportHours : 0;
    rowHeights.set(rowNumber, 22);
    return `${identityCells}${dailyCells}${formulaCell(`AL${rowNumber}`, `SUM(G${rowNumber}:AK${rowNumber})`, row.timesheetHours, 10)}${formulaCell(`AM${rowNumber}`, `IF(B${rowNumber}="ОПР",AL${rowNumber}-AU${rowNumber},0)`, difference, difference === 0 ? 10 : 11)}${cell(`AN${rowNumber}`, row.masters, 12)}${cell(`AU${rowNumber}`, row.reportHours)}`;
  });
  dataRows.forEach((value, index) => addRowCells(index + firstDataRow, value));
  const totalRowNumber = rows.length + firstDataRow;
  const totalDailyCells = Array.from({ length: dayColumnCount }, (_, index) => dates[index]
    ? formulaCell(`${columnLetter(dayStartColumn + index)}${totalRowNumber}`, sumDataColumn(columnLetter(dayStartColumn + index)), dayTotals[index] ?? 0, 14)
    : cell(`${columnLetter(dayStartColumn + index)}${totalRowNumber}`, "", 14)).join("");
  addRowCells(totalRowNumber, `${cell(`D${totalRowNumber}`, "ИТОГО", 13)}${totalDailyCells}${formulaCell(`AL${totalRowNumber}`, sumDataColumn("AL"), totalHours, 14)}${formulaCell(`AM${totalRowNumber}`, sumDataColumn("AM"), totalDifference, totalDifference === 0 ? 14 : 15)}${cell(`AN${totalRowNumber}`, "", 12)}`);
  rowHeights.set(totalRowNumber, 24);
  const reportHoursTotal = rows.reduce((sum, row) => sum + row.reportHours, 0);
  const firstDate = dates[0] ?? "";
  const lastDate = dates.at(-1) ?? firstDate;
  const formatShortDate = (value: string) => {
    const [year, month, day] = value.split("-");
    return value ? `${day}/${month}/${year.slice(-2)}` : "";
  };
  addRowCells(4, `${cell("AP4", "Часы по табелю", 13)}${formulaCell("AQ4", sumDataColumn("AL"), totalHours, 15)}${cell("AS4", formatShortDate(firstDate), 14)}${cell("AT4", formatShortDate(lastDate), 14)}`);
  addRowCells(5, `${cell("AP5", "Часы по расстановке", 13)}${formulaCell("AQ5", sumDataColumn("AU"), reportHoursTotal, 15)}`);
  addRowCells(6, `${cell("AP6", "Итого по расстановке", 13)}${formulaCell("AQ6", sumDataColumn("AU"), reportHoursTotal, 15)}`);
  const columns = [
    '<col min="1" max="1" width="3" customWidth="1"/>',
    '<col min="2" max="2" width="10" customWidth="1"/>',
    '<col min="3" max="3" width="14" customWidth="1"/>',
    '<col min="4" max="4" width="34" customWidth="1"/>',
    '<col min="5" max="5" width="36" customWidth="1"/>',
    '<col min="6" max="6" width="16" customWidth="1"/>',
    ...Array.from({ length: dayColumnCount }, (_, index) => `<col min="${dayStartColumn + index + 1}" max="${dayStartColumn + index + 1}" width="5.5" customWidth="1"/>`),
    `<col min="${hoursColumn + 1}" max="${differenceColumn + 1}" width="10" customWidth="1"/>`,
    `<col min="${masterColumn + 1}" max="${masterColumn + 1}" width="28" customWidth="1"/>`,
    '<col min="41" max="41" width="3" customWidth="1"/>',
    '<col min="42" max="42" width="21" customWidth="1"/>',
    '<col min="43" max="43" width="11" customWidth="1"/>',
    '<col min="44" max="44" width="3" customWidth="1"/>',
    '<col min="45" max="46" width="13" customWidth="1"/>',
    `<col min="${reportHoursColumn + 1}" max="${reportHoursColumn + 1}" width="0" hidden="1" customWidth="1"/>`,
  ].join("");
  const lastContentRow = Math.max(totalRowNumber, 6);
  const sheetRows = Array.from({ length: lastContentRow }, (_, index) => index + 1).map((rowNumber) => {
    const sortedCells = ((rowCells.get(rowNumber) ?? []).join("").match(/<c\b.*?<\/c>/g) ?? [])
      .sort((left, right) => cellXmlColumnIndex(left) - cellXmlColumnIndex(right));
    return `<row r="${rowNumber}"${rowHeights.has(rowNumber) ? ` ht="${rowHeights.get(rowNumber)}"` : ""}>${sortedCells.join("")}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="B2:AU${lastContentRow}"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="6" ySplit="2" topLeftCell="G3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="B2:F${totalRowNumber}"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddHeader>&amp;C${xml(`${siteName} — ${monthLabel}`)}</oddHeader></headerFooter></worksheet>`;
  return downloadBlob(zip(workbookFiles(worksheet, undefined, "Табель")));
}

export function createEquipmentTimesheetXlsx(siteName: string, monthLabel: string, dates: string[], rows: EquipmentTimesheetExportRow[], dayTotals: number[], productiveTotal: number, downtimeTotal: number, totalHours: number) {
  const identityColumnCount = 3;
  const dayStartColumn = identityColumnCount;
  const dayColumnCount = 31;
  const productiveColumn = dayStartColumn + dayColumnCount;
  const downtimeColumn = productiveColumn + 1;
  const totalColumn = downtimeColumn + 1;
  const firstDataRow = 3;
  const lastDataRow = rows.length + 2;
  const totalRowNumber = rows.length + firstDataRow;
  const sumDataColumn = (column: string) => rows.length ? `SUM(${column}${firstDataRow}:${column}${lastDataRow})` : "0";
  const headerCells = ["№", "Техника", "Организация"].map((header, index) => cell(`${columnLetter(index)}2`, header, 4)).join("");
  const dateCells = Array.from({ length: dayColumnCount }, (_, index) => dates[index]
    ? cell(`${columnLetter(dayStartColumn + index)}2`, excelDateSerial(dates[index]), 5)
    : cell(`${columnLetter(dayStartColumn + index)}2`, "", 5)).join("");
  const summaryHeaders = [
    cell(`${columnLetter(productiveColumn)}2`, "РАБОТА", 4),
    cell(`${columnLetter(downtimeColumn)}2`, "ПРОСТОЙ", 4),
    cell(`${columnLetter(totalColumn)}2`, "ВСЕГО", 4),
  ].join("");
  const dataRows = rows.map((row, index) => {
    const rowNumber = index + firstDataRow;
    const identityCells = [index + 1, row.equipmentName, row.organization]
      .map((value, column) => cell(`${columnLetter(column)}${rowNumber}`, value, column === 0 ? 8 : 7)).join("");
    const dailyCells = Array.from({ length: dayColumnCount }, (_, dayIndex) => {
      const date = dates[dayIndex];
      const dayOfWeek = date ? new Date(`${date}T00:00:00Z`).getUTCDay() : -1;
      return cell(`${columnLetter(dayStartColumn + dayIndex)}${rowNumber}`, row.dailyValues[dayIndex] ?? "", dayOfWeek === 0 || dayOfWeek === 6 ? 9 : 8);
    }).join("");
    return `<row r="${rowNumber}" ht="22">${identityCells}${dailyCells}${cell(`${columnLetter(productiveColumn)}${rowNumber}`, row.productiveHours, 10)}${cell(`${columnLetter(downtimeColumn)}${rowNumber}`, row.downtimeHours, row.downtimeHours > 0 ? 11 : 10)}${cell(`${columnLetter(totalColumn)}${rowNumber}`, row.totalHours, 14)}</row>`;
  }).join("");
  const totalDailyCells = Array.from({ length: dayColumnCount }, (_, index) => dates[index]
    ? cell(`${columnLetter(dayStartColumn + index)}${totalRowNumber}`, dayTotals[index] ?? 0, 14)
    : cell(`${columnLetter(dayStartColumn + index)}${totalRowNumber}`, "", 14)).join("");
  const totalRow = `<row r="${totalRowNumber}" ht="24">${cell(`B${totalRowNumber}`, "ИТОГО", 13)}${totalDailyCells}${formulaCell(`${columnLetter(productiveColumn)}${totalRowNumber}`, sumDataColumn(columnLetter(productiveColumn)), productiveTotal, 14)}${formulaCell(`${columnLetter(downtimeColumn)}${totalRowNumber}`, sumDataColumn(columnLetter(downtimeColumn)), downtimeTotal, downtimeTotal > 0 ? 15 : 14)}${formulaCell(`${columnLetter(totalColumn)}${totalRowNumber}`, sumDataColumn(columnLetter(totalColumn)), totalHours, 14)}</row>`;
  const columns = [
    '<col min="1" max="1" width="6" customWidth="1"/>',
    '<col min="2" max="2" width="42" customWidth="1"/>',
    '<col min="3" max="3" width="22" customWidth="1"/>',
    ...Array.from({ length: dayColumnCount }, (_, index) => `<col min="${dayStartColumn + index + 1}" max="${dayStartColumn + index + 1}" width="7.5" customWidth="1"/>`),
    `<col min="${productiveColumn + 1}" max="${totalColumn + 1}" width="11" customWidth="1"/>`,
  ].join("");
  const lastColumn = columnLetter(totalColumn);
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A2:${lastColumn}${totalRowNumber}"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData><row r="1" ht="10.5"></row><row r="2" ht="32">${headerCells}${dateCells}${summaryHeaders}</row>${dataRows}${totalRow}</sheetData><autoFilter ref="A2:C${totalRowNumber}"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddHeader>&amp;C${xml(`${siteName} — ${monthLabel}`)}</oddHeader></headerFooter></worksheet>`;
  return downloadBlob(zip(workbookFiles(worksheet, undefined, "Табель")));
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

function elementsByLocalName(container: Document | Element, name: string) {
  return Array.from(container.getElementsByTagNameNS("*", name));
}

function readWorksheetRows(document: Document, shared: string[]) {
  return elementsByLocalName(document, "row").map((row) => {
    const values = new Map<number, string>();
    for (const cellNode of elementsByLocalName(row, "c")) {
      const ref = cellNode.getAttribute("r") ?? "A1";
      const lettersOnly = ref.match(/[A-Z]+/)?.[0] ?? "A";
      let column = 0;
      for (const character of lettersOnly) column = column * 26 + character.charCodeAt(0) - 64;
      const type = cellNode.getAttribute("t");
      const raw = type === "inlineStr"
        ? elementsByLocalName(cellNode, "is")[0]?.textContent ?? ""
        : elementsByLocalName(cellNode, "v")[0]?.textContent ?? "";
      values.set(column - 1, type === "s" ? shared[Number(raw)] ?? "" : raw);
    }
    return values;
  });
}

function readSharedStrings(parser: DOMParser, sharedXml: string | null) {
  if (!sharedXml) return [];
  return elementsByLocalName(parser.parseFromString(sharedXml, "application/xml"), "si").map((node) => node.textContent ?? "");
}

export async function parseTableXlsx(file: File, requiredHeaders: string[]) {
  const buffer = await file.arrayBuffer();
  const worksheetXml = await unzipEntry(buffer, "xl/worksheets/sheet1.xml");
  if (!worksheetXml) throw new Error("В файле нет первого листа.");
  const sharedXml = await unzipEntry(buffer, "xl/sharedStrings.xml");
  const parser = new DOMParser();
  const shared = readSharedStrings(parser, sharedXml);
  const document = parser.parseFromString(worksheetXml, "application/xml");
  if (elementsByLocalName(document, "parsererror").length) throw new Error("Не удалось прочитать структуру XLSX.");
  const parsedRows = readWorksheetRows(document, shared);
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
  const shared = readSharedStrings(parser, sharedXml);
  const document = parser.parseFromString(worksheetXml, "application/xml");
  if (elementsByLocalName(document, "parsererror").length) throw new Error("Не удалось прочитать структуру XLSX.");
  const parsedRows = readWorksheetRows(document, shared);
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

export async function parseEquipmentRegistryXlsx(file: File): Promise<EquipmentRegistryImportRow[]> {
  const buffer = await file.arrayBuffer();
  const sharedXml = await unzipEntry(buffer, "xl/sharedStrings.xml");
  const parser = new DOMParser();
  const shared = readSharedStrings(parser, sharedXml);
  const required = ["организация", "тип", "марка", "модель"];

  for (let sheetNumber = 1; sheetNumber <= 20; sheetNumber += 1) {
    const worksheetXml = await unzipEntry(buffer, `xl/worksheets/sheet${sheetNumber}.xml`);
    if (!worksheetXml) continue;
    const document = parser.parseFromString(worksheetXml, "application/xml");
    if (elementsByLocalName(document, "parsererror").length) continue;
    const parsedRows = readWorksheetRows(document, shared);
    const headerIndex = parsedRows.findIndex((row) => {
      const values = Array.from(row.values()).map(normalizeHeader);
      return required.every((header) => values.includes(header))
        && values.some((header) => header.includes("грз") || header.includes("инв."));
    });
    if (headerIndex < 0) continue;

    const headerMap = new Map<string, number>();
    parsedRows[headerIndex].forEach((value, column) => headerMap.set(normalizeHeader(value), column));
    const column = (...names: string[]) => {
      const normalizedNames = names.map(normalizeHeader);
      return Array.from(headerMap.entries()).find(([header]) => normalizedNames.some((name) => header === name || header.includes(name)))?.[1];
    };
    const organizationColumn = column("Организация");
    const typeColumn = column("Тип");
    const brandColumn = column("Марка");
    const modelColumn = column("Модель");
    const registrationColumn = column("ГРЗ / Инв. №", "ГРЗ", "Инв. №");
    const projectColumn = column("Проект", "Объект");
    const noteColumn = column("Примечание");
    if ([organizationColumn, typeColumn, brandColumn, modelColumn, registrationColumn].some((value) => value === undefined)) continue;

    return parsedRows.slice(headerIndex + 1).map((row) => ({
      organization: row.get(organizationColumn!)?.trim() ?? "",
      equipmentType: row.get(typeColumn!)?.trim() ?? "",
      brand: row.get(brandColumn!)?.trim() ?? "",
      model: row.get(modelColumn!)?.trim() ?? "",
      registrationNumber: row.get(registrationColumn!)?.trim() ?? "",
      projectName: projectColumn === undefined ? undefined : row.get(projectColumn)?.trim() ?? "",
      note: noteColumn === undefined ? "" : row.get(noteColumn)?.trim() ?? "",
    })).filter((row) => row.organization && row.equipmentType && row.model && Object.values(row).some((value) => value && value !== "-"));
  }

  throw new Error("Не найден лист реестра техники со столбцами «Организация», «Тип», «Марка», «Модель» и «ГРЗ / Инв. №».");
}

function excelDate(value: string) {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const russian = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (russian) return `${russian[3]}-${russian[2].padStart(2, "0")}-${russian[1].padStart(2, "0")}`;
  const serial = Number(trimmed);
  if (!Number.isFinite(serial) || serial < 1) return "";
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

export async function parseEquipmentEntriesXlsx(file: File): Promise<EquipmentEntryImportRow[]> {
  const buffer = await file.arrayBuffer();
  const sharedXml = await unzipEntry(buffer, "xl/sharedStrings.xml");
  const parser = new DOMParser();
  const shared = readSharedStrings(parser, sharedXml);

  for (let sheetNumber = 1; sheetNumber <= 20; sheetNumber += 1) {
    const worksheetXml = await unzipEntry(buffer, `xl/worksheets/sheet${sheetNumber}.xml`);
    if (!worksheetXml) continue;
    const document = parser.parseFromString(worksheetXml, "application/xml");
    if (elementsByLocalName(document, "parsererror").length) continue;
    const parsedRows = readWorksheetRows(document, shared);
    const headerIndex = parsedRows.findIndex((row) => {
      const values = Array.from(row.values()).map(normalizeHeader);
      return values.includes("дата") && values.includes("уникальное наименование единицы")
        && values.includes("смена") && values.includes("зона") && values.includes("часы");
    });
    if (headerIndex < 0) continue;

    const headerMap = new Map<string, number>();
    parsedRows[headerIndex].forEach((value, column) => headerMap.set(normalizeHeader(value), column));
    const column = (...names: string[]) => names.map(normalizeHeader).map((name) => headerMap.get(name)).find((value) => value !== undefined);
    const dateColumn = column("Дата");
    const equipmentColumn = column("Уникальное наименование единицы");
    const shiftColumn = column("Смена");
    const zoneColumn = column("Зона");
    const mainColumn = column("Виды основных работ", "Основная работа");
    const subworkColumn = column("Виды подработ", "Вид подработ");
    const noteColumn = column("Примечание");
    const hoursColumn = column("Часы");
    if ([dateColumn, equipmentColumn, shiftColumn, zoneColumn, mainColumn, subworkColumn, hoursColumn].some((value) => value === undefined)) continue;

    return parsedRows.slice(headerIndex + 1).map((row) => ({
      workDate: excelDate(row.get(dateColumn!) ?? ""),
      equipmentName: row.get(equipmentColumn!)?.trim() ?? "",
      shiftName: row.get(shiftColumn!)?.trim() ?? "",
      zoneName: row.get(zoneColumn!)?.trim() ?? "",
      mainWorkTypeName: row.get(mainColumn!)?.trim() ?? "",
      subworkTypeName: row.get(subworkColumn!)?.trim() ?? "",
      note: noteColumn === undefined ? "" : row.get(noteColumn)?.trim() ?? "",
      hours: row.get(hoursColumn!)?.trim() ?? "",
    })).filter((row) => row.workDate && row.equipmentName && row.equipmentName !== "-" && row.hours && row.hours !== "-");
  }

  throw new Error("Не найден лист расстановки техники с датой, техникой, сменой, зоной, работами и часами.");
}
