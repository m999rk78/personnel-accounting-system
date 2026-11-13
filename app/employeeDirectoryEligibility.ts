/** Apply to current selection lists, never to queries loading saved reports or timesheets. */
export function currentEmployeeDirectoryFilter(employee: string) {
  return `${employee}.active = 1 AND COALESCE(${employee}.availability_status, '') NOT IN ('dismissed', 'blacklisted', 'deleted', 'central_office')
    AND NOT EXISTS (SELECT 1 FROM bitrix24_employee_check_states terminal_check
      WHERE terminal_check.employee_id = ${employee}.id AND terminal_check.status IN ('dismissed_in_bitrix', 'blacklisted_in_bitrix'))`;
}

/** Linked masters follow their employee; manual master entries have no employee status. */
export function currentMasterDirectoryFilter(master: string) {
  return `${master}.active = 1 AND (${master}.employee_id IS NULL OR EXISTS (
    SELECT 1 FROM employees master_employee WHERE master_employee.id = ${master}.employee_id
      AND ${currentEmployeeDirectoryFilter("master_employee")}))`;
}
