import type { PostgresDatabase } from "../db/client";

/** Historical marks must retain their equipment even after removal from the project or registry. */
export function equipmentTimesheetUnitsStatement(database: Pick<PostgresDatabase, "prepare">, siteId: number, monthStart: string, monthEnd: string) {
  return database.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
      eu.registration_number AS "registrationNumber", eu.note
    FROM equipment_units eu
    WHERE eu.id IN (
      SELECT epa.equipment_id FROM equipment_project_assignments epa
      JOIN equipment_units assigned ON assigned.id = epa.equipment_id AND assigned.active = 1
      WHERE epa.site_id = ? AND epa.active = 1
      UNION
      SELECT ee.equipment_id FROM equipment_entries ee
      WHERE ee.site_id = ? AND ee.work_date >= ? AND ee.work_date < ? AND ee.deleted_at IS NULL
      UNION
      SELECT etm.equipment_id FROM equipment_timesheet_marks etm
      WHERE etm.site_id = ? AND etm.work_date >= ? AND etm.work_date < ?
    )
    ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`)
    .bind(siteId, siteId, monthStart, monthEnd, siteId, monthStart, monthEnd);
}
