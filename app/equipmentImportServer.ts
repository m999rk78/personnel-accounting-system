import type { PostgresDatabase } from "../db/client";
import { equipmentUnavailableReason } from "./equipmentAvailability.ts";
import { normalizeEquipmentImportName, normalizeEquipmentImportRows, planEquipmentImport, type EquipmentImportOption, type EquipmentImportUnit } from "./equipmentImport.ts";

type ImportTransaction = Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];
type ImportActor = { id: number; fullName: string; role: string };

/** References, new zones, entries and contribution updates commit or roll back together. */
export async function importEquipmentEntries(
  db: Pick<PostgresDatabase, "transaction">,
  siteId: number,
  input: unknown,
  actor: ImportActor,
  onImportedDates?: (transaction: ImportTransaction, dates: string[]) => Promise<void>,
) {
  return db.transaction(async (transaction) => {
    const rows = normalizeEquipmentImportRows(input);
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-import:${siteId}`).first();
    const site = await transaction.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    const units = await transaction.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
        eu.registration_number AS "registrationNumber" FROM equipment_units eu
      JOIN equipment_project_assignments epa ON epa.equipment_id = eu.id
      WHERE epa.site_id = ? AND epa.active = 1 AND eu.active = 1
      ORDER BY eu.id FOR SHARE OF eu, epa`).bind(siteId).all<EquipmentImportUnit>();
    const shifts = await transaction.prepare("SELECT id, name FROM shifts WHERE site_id = ? AND active = 1 FOR SHARE").bind(siteId).all<EquipmentImportOption>();
    const mainWorkTypes = await transaction.prepare("SELECT id, name FROM main_work_types WHERE site_id = ? AND active = 1 FOR SHARE").bind(siteId).all<EquipmentImportOption>();
    const subworkTypes = await transaction.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE site_id = ? AND active = 1 FOR SHARE").bind(siteId).all<EquipmentImportOption>();
    const prepared = planEquipmentImport(rows, { units: units.results, shifts: shifts.results, mainWorkTypes: mainWorkTypes.results, subworkTypes: subworkTypes.results });

    const zones = await transaction.prepare("SELECT id, name, active FROM zones WHERE site_id = ? ORDER BY id FOR UPDATE").bind(siteId).all<EquipmentImportOption>();
    const zoneIndex = new Map<string, EquipmentImportOption[]>();
    for (const zone of zones.results) {
      const key = normalizeEquipmentImportName(zone.name);
      const matching = zoneIndex.get(key) ?? [];
      matching.push(zone);
      zoneIndex.set(key, matching);
    }
    const zonePlans = new Map<string, { name: string; existing?: EquipmentImportOption }>();
    for (const row of prepared) {
      const key = normalizeEquipmentImportName(row.zoneName);
      if (zonePlans.has(key)) continue;
      const matching = zoneIndex.get(key) ?? [];
      const active = matching.filter((zone) => zone.active === 1);
      const candidates = active.length ? active : matching;
      if (candidates.length > 1) throw new Error(`Строка ${row.rowNumber}: зона «${row.zoneName}» неоднозначна: исправьте повторяющиеся названия в справочнике.`);
      zonePlans.set(key, { name: row.zoneName, existing: candidates[0] });
    }

    // Every writer uses the same equipment/day lock. A stable order avoids cross-file deadlocks.
    const locks = [...new Set(prepared.map((row) => `equipment-hours:${row.workDate}:${row.equipmentId}`))].sort();
    for (const key of locks) await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(key).first();
    const zoneIds = new Map<string, number>();
    for (const [key, plan] of zonePlans) {
      if (plan.existing) {
        if (plan.existing.active !== 1) await transaction.prepare("UPDATE zones SET active = 1 WHERE id = ? AND site_id = ?").bind(plan.existing.id, siteId).run();
        zoneIds.set(key, plan.existing.id);
      } else {
        const created = await transaction.prepare("INSERT INTO zones (site_id, name, active) VALUES (?, ?, 1) RETURNING id").bind(siteId, plan.name).first<{ id: number }>();
        if (!created?.id) throw new Error("Не удалось создать зону отчёта.");
        zoneIds.set(key, created.id);
      }
    }

    let imported = 0;
    let skipped = 0;
    const importedDates = new Set<string>();
    for (const entry of prepared) {
      const zoneId = zoneIds.get(normalizeEquipmentImportName(entry.zoneName))!;
      const existing = await transaction.prepare(`SELECT id FROM equipment_entries
        WHERE site_id = ? AND work_date = ? AND equipment_id = ? AND shift_id = ? AND zone_id = ?
          AND main_work_type_id = ? AND subwork_type_id = ? AND note = ? AND hours = ? AND deleted_at IS NULL
        LIMIT 1`).bind(siteId, entry.workDate, entry.equipmentId, entry.shiftId, zoneId, entry.mainWorkTypeId, entry.subworkTypeId, entry.note, entry.hours).first();
      if (existing) { skipped += 1; continue; }
      const conflict = await transaction.prepare(`SELECT productive_hours AS "productiveHours", downtime_hours AS "downtimeHours", note
        FROM equipment_timesheet_marks WHERE site_id = ? AND equipment_id = ? AND work_date = ?
          AND productive_hours = 0 AND downtime_hours > 0 LIMIT 1`)
        .bind(siteId, entry.equipmentId, entry.workDate).first<{ productiveHours: number; downtimeHours: number; note: string }>();
      if (conflict) throw new Error(`Строка ${entry.rowNumber}: техника недоступна по табелю: ${equipmentUnavailableReason(conflict)}. Исправьте отметку табеля техники.`);
      const used = await transaction.prepare(`SELECT COALESCE(SUM(hours), 0) AS hours FROM equipment_entries
        WHERE site_id = ? AND work_date = ? AND equipment_id = ? AND deleted_at IS NULL`)
        .bind(siteId, entry.workDate, entry.equipmentId).first<{ hours: number }>();
      if (Number(used?.hours ?? 0) + entry.hours > 20) throw new Error(`Строка ${entry.rowNumber}: у техники уже учтено ${Number(used?.hours ?? 0)} ч. За сутки можно указать не более 20 ч.`);
      await transaction.prepare(`INSERT INTO equipment_entries
        (site_id, work_date, equipment_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, hours, created_by,
         responsible_user_id, created_by_user_id, updated_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(siteId, entry.workDate, entry.equipmentId, entry.shiftId, zoneId, entry.mainWorkTypeId, entry.subworkTypeId, entry.note, entry.hours,
          actor.fullName, actor.role === "foreman" ? actor.id : null, actor.id, actor.id).run();
      imported += 1;
      importedDates.add(entry.workDate);
    }
    if (onImportedDates && importedDates.size) await onImportedDates(transaction, [...importedDates]);
    return { imported, skipped };
  });
}
