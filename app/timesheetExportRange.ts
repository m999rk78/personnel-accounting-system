import type { EquipmentTimesheetExportRow, PersonnelTimesheetExportRow } from "./placementXlsx";

export type PersonnelTimesheetMonthData = {
  employees: Array<{ id: number; fullName: string; employmentType: string; department: string; position: string }>;
  entries: Array<{ employeeId: number; workDate: string; hours: number; masters: string; zones: string }>;
  marks: Array<{ employeeId: number; workDate: string; hours: number | null; code: string | null; note: string; updatedBy: string }>;
};

export type EquipmentTimesheetMonthData = {
  units: Array<{ id: number; organization: string; equipmentType: string; brand: string; model: string; registrationNumber: string }>;
  entries: Array<{
    equipmentId: number;
    workDate: string;
    hours: number;
    organization: string;
    equipmentType: string;
    brand: string;
    model: string;
    registrationNumber: string;
    subworkTypeName: string;
  }>;
  marks: Array<{ equipmentId: number; workDate: string; productiveHours: number; downtimeHours: number; note: string; updatedBy: string }>;
};

function checkedRange(start: string, end: string) {
  if (!start || !end || start > end) throw new Error("Проверьте даты начала и окончания периода.");
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) throw new Error("Проверьте даты начала и окончания периода.");
  const days = Math.floor((endTime - startTime) / 86400000) + 1;
  if (days > 366) throw new Error("Для выгрузки можно выбрать период не более 366 дней.");
  return { startTime, days };
}

export function dateKeysInRange(start: string, end: string) {
  const { startTime, days } = checkedRange(start, end);
  return Array.from({ length: days }, (_, index) => new Date(startTime + index * 86400000).toISOString().slice(0, 10));
}

export function monthKeysInRange(start: string, end: string) {
  checkedRange(start, end);
  const months: string[] = [];
  let current = `${start.slice(0, 7)}-01`;
  const last = `${end.slice(0, 7)}-01`;
  while (current <= last) {
    months.push(current.slice(0, 7));
    const date = new Date(`${current}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    current = date.toISOString().slice(0, 10);
  }
  return months;
}

function selectedIndices(dates: string[], start: string, end: string) {
  if (!start || !end || start > end) throw new Error("Проверьте даты начала и окончания периода.");
  const indices = dates.flatMap((date, index) => date >= start && date <= end ? [index] : []);
  if (!indices.length || start < (dates[0] ?? "") || end > (dates.at(-1) ?? "")) {
    throw new Error("Для табеля можно выбрать даты только в пределах открытого месяца.");
  }
  return indices;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function personnelCellKey(employeeId: number, workDate: string) {
  return `${employeeId}:${workDate}`;
}

function equipmentCellKey(equipmentId: number, workDate: string) {
  return `${equipmentId}:${workDate}`;
}

function equipmentTitle(unit: EquipmentTimesheetMonthData["units"][number]) {
  return [unit.equipmentType, unit.brand, unit.model, unit.registrationNumber && unit.registrationNumber !== "-" ? `• ${unit.registrationNumber}` : ""].filter(Boolean).join(" ");
}

function equipmentExportName(unit: EquipmentTimesheetMonthData["units"][number]) {
  return `${unit.equipmentType} // ${[unit.brand, unit.model].filter(Boolean).join(" ")} // ${unit.registrationNumber || "-"} // ${unit.organization}`;
}

function isEquipmentDowntime(entry: EquipmentTimesheetMonthData["entries"][number]) {
  return entry.subworkTypeName.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ").includes("простой");
}

export function buildPersonnelTimesheetRange(months: PersonnelTimesheetMonthData[], start: string, end: string) {
  const dates = dateKeysInRange(start, end);
  const employees = new Map<number, PersonnelTimesheetMonthData["employees"][number]>();
  const entries = new Map<string, PersonnelTimesheetMonthData["entries"][number]>();
  const marks = new Map<string, PersonnelTimesheetMonthData["marks"][number]>();
  for (const month of months) {
    for (const employee of month.employees) employees.set(employee.id, employee);
    for (const entry of month.entries) entries.set(personnelCellKey(entry.employeeId, entry.workDate), entry);
    for (const mark of month.marks) marks.set(personnelCellKey(mark.employeeId, mark.workDate), mark);
  }
  const rows = Array.from(employees.values())
    .sort((left, right) => {
      const leftOpr = left.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР";
      const rightOpr = right.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР";
      return leftOpr !== rightOpr ? (leftOpr ? 1 : -1) : left.fullName.localeCompare(right.fullName, "ru");
    })
    .map((employee): PersonnelTimesheetExportRow => {
      const reportTracked = employee.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР";
      const dailyTimesheetHours: number[] = [];
      const dailyReportHours: number[] = [];
      const dailyMasters: string[] = [];
      const dailyValues = dates.map((date) => {
        const key = personnelCellKey(employee.id, date);
        const entry = reportTracked ? entries.get(key) : undefined;
        const mark = marks.get(key);
        dailyTimesheetHours.push(mark?.code ? 0 : mark?.hours !== null && mark?.hours !== undefined ? Number(mark.hours) : Number(entry?.hours ?? 0));
        dailyReportHours.push(Number(entry?.hours ?? 0));
        dailyMasters.push(entry?.masters ?? "");
        return mark?.code ?? mark?.hours ?? entry?.hours ?? "";
      });
      const masterNames = new Set(dailyMasters.flatMap((value) => value.split(/[,;]/).map((name) => name.trim()).filter(Boolean)));
      return {
        employmentType: employee.employmentType,
        department: employee.department,
        fullName: employee.fullName,
        position: employee.position,
        positionNote: "",
        dailyValues,
        dailyTimesheetHours,
        dailyReportHours,
        dailyMasters,
        timesheetHours: sum(dailyTimesheetHours),
        reportHours: sum(dailyReportHours),
        masters: Array.from(masterNames).join(", "),
      };
    });
  const dayTotals = dates.map((_, index) => rows.reduce((total, row) => total + row.dailyTimesheetHours[index], 0));
  const totalHours = rows.reduce((total, row) => total + row.timesheetHours, 0);
  const totalDifference = rows.reduce((total, row) => total + (row.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР" ? row.timesheetHours - row.reportHours : 0), 0);
  return { dates, rows, dayTotals, totalHours, totalDifference };
}

export function buildEquipmentTimesheetRange(months: EquipmentTimesheetMonthData[], start: string, end: string) {
  const dates = dateKeysInRange(start, end);
  const units = new Map<number, EquipmentTimesheetMonthData["units"][number]>();
  const reportHours = new Map<string, { productive: number; downtime: number }>();
  const marks = new Map<string, EquipmentTimesheetMonthData["marks"][number]>();
  for (const month of months) {
    for (const unit of month.units) units.set(unit.id, unit);
    for (const entry of month.entries) {
      if (!units.has(entry.equipmentId)) units.set(entry.equipmentId, { id: entry.equipmentId, organization: entry.organization, equipmentType: entry.equipmentType, brand: entry.brand, model: entry.model, registrationNumber: entry.registrationNumber });
      const key = equipmentCellKey(entry.equipmentId, entry.workDate);
      const current = reportHours.get(key) ?? { productive: 0, downtime: 0 };
      if (isEquipmentDowntime(entry)) current.downtime += Number(entry.hours);
      else current.productive += Number(entry.hours);
      reportHours.set(key, current);
    }
    for (const mark of month.marks) marks.set(equipmentCellKey(mark.equipmentId, mark.workDate), mark);
  }
  const rows = Array.from(units.values())
    .sort((left, right) => equipmentTitle(left).localeCompare(equipmentTitle(right), "ru", { numeric: true }))
    .map((unit): EquipmentTimesheetExportRow => {
      const dailyProductiveHours: number[] = [];
      const dailyDowntimeHours: number[] = [];
      const dailyReportHours: number[] = [];
      const dailyValues = dates.map((date) => {
        const key = equipmentCellKey(unit.id, date);
        const report = reportHours.get(key) ?? { productive: 0, downtime: 0 };
        const mark = marks.get(key);
        const productive = mark ? Number(mark.productiveHours) : report.productive;
        const downtime = mark ? Number(mark.downtimeHours) : report.downtime;
        dailyProductiveHours.push(productive);
        dailyDowntimeHours.push(downtime);
        dailyReportHours.push(report.productive + report.downtime);
        if (!mark && productive === 0 && downtime === 0) return "";
        if (productive && downtime) return `${productive} / П ${downtime}`;
        if (downtime) return `П ${downtime}`;
        return productive || "";
      });
      const productiveHours = sum(dailyProductiveHours);
      const downtimeHours = sum(dailyDowntimeHours);
      return {
        equipmentName: equipmentExportName(unit),
        organization: unit.organization,
        equipmentType: unit.equipmentType,
        registrationNumber: unit.registrationNumber,
        dailyValues,
        dailyProductiveHours,
        dailyDowntimeHours,
        dailyReportHours,
        productiveHours,
        downtimeHours,
        reportHours: sum(dailyReportHours),
        totalHours: productiveHours + downtimeHours,
      };
    });
  const dayTotals = dates.map((_, index) => rows.reduce((total, row) => total + row.dailyProductiveHours[index] + row.dailyDowntimeHours[index], 0));
  const productiveTotal = rows.reduce((total, row) => total + row.productiveHours, 0);
  const downtimeTotal = rows.reduce((total, row) => total + row.downtimeHours, 0);
  return { dates, rows, dayTotals, productiveTotal, downtimeTotal, totalHours: productiveTotal + downtimeTotal };
}

export function selectPersonnelTimesheetRange(
  dates: string[],
  rows: PersonnelTimesheetExportRow[],
  dayTotals: number[],
  start: string,
  end: string,
) {
  const indices = selectedIndices(dates, start, end);
  const selectedDates = indices.map((index) => dates[index]);
  const selectedRows = rows.map((row) => {
    const dailyTimesheetHours = indices.map((index) => row.dailyTimesheetHours[index] ?? 0);
    const dailyReportHours = indices.map((index) => row.dailyReportHours[index] ?? 0);
    const masters = new Set(indices.flatMap((index) => (row.dailyMasters[index] ?? "").split(/[,;]/).map((value) => value.trim()).filter(Boolean)));
    return {
      ...row,
      dailyValues: indices.map((index) => row.dailyValues[index] ?? ""),
      dailyTimesheetHours,
      dailyReportHours,
      dailyMasters: indices.map((index) => row.dailyMasters[index] ?? ""),
      timesheetHours: sum(dailyTimesheetHours),
      reportHours: sum(dailyReportHours),
      masters: Array.from(masters).join(", "),
    };
  });
  const totalHours = selectedRows.reduce((total, row) => total + row.timesheetHours, 0);
  const totalDifference = selectedRows.reduce((total, row) => total + (row.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР" ? row.timesheetHours - row.reportHours : 0), 0);
  return {
    dates: selectedDates,
    rows: selectedRows,
    dayTotals: indices.map((index) => dayTotals[index] ?? 0),
    totalHours,
    totalDifference,
  };
}

export function selectEquipmentTimesheetRange(
  dates: string[],
  rows: EquipmentTimesheetExportRow[],
  dayTotals: number[],
  start: string,
  end: string,
) {
  const indices = selectedIndices(dates, start, end);
  const selectedDates = indices.map((index) => dates[index]);
  const selectedRows = rows.map((row) => {
    const dailyProductiveHours = indices.map((index) => row.dailyProductiveHours[index] ?? 0);
    const dailyDowntimeHours = indices.map((index) => row.dailyDowntimeHours[index] ?? 0);
    const dailyReportHours = indices.map((index) => row.dailyReportHours?.[index] ?? 0);
    const productiveHours = sum(dailyProductiveHours);
    const downtimeHours = sum(dailyDowntimeHours);
    return {
      ...row,
      dailyValues: indices.map((index) => row.dailyValues[index] ?? ""),
      dailyProductiveHours,
      dailyDowntimeHours,
      dailyReportHours,
      productiveHours,
      downtimeHours,
      reportHours: row.dailyReportHours ? sum(dailyReportHours) : row.reportHours,
      totalHours: productiveHours + downtimeHours,
    };
  });
  const productiveTotal = selectedRows.reduce((total, row) => total + row.productiveHours, 0);
  const downtimeTotal = selectedRows.reduce((total, row) => total + row.downtimeHours, 0);
  return {
    dates: selectedDates,
    rows: selectedRows,
    dayTotals: indices.map((index) => dayTotals[index] ?? 0),
    productiveTotal,
    downtimeTotal,
    totalHours: productiveTotal + downtimeTotal,
  };
}
