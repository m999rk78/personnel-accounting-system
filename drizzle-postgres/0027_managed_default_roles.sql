-- Make all default roles except Super-admin ordinary editable catalog entries.
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS legacy_role_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_roles_legacy_key ON custom_roles(legacy_role_key);
--> statement-breakpoint
ALTER TABLE custom_roles DROP CONSTRAINT IF EXISTS custom_roles_base_role_check;
--> statement-breakpoint
ALTER TABLE custom_roles ADD CONSTRAINT custom_roles_base_role_check CHECK(base_role IN ('foreman','engineer','viewer'));
--> statement-breakpoint
INSERT INTO custom_roles(name,name_key,base_role,permissions,legacy_role_key)
VALUES('Прораб','прораб','foreman','{"workers_report":{"view":true,"create":true,"update":true,"delete":true},"equipment_report":{"view":true,"create":true,"update":true,"delete":true},"workers_timesheet":{"view":false,"create":false,"update":false,"delete":false},"equipment_timesheet":{"view":false,"create":false,"update":false,"delete":false},"employees":{"view":false,"create":false,"update":false,"delete":false},"equipment_registry":{"view":false,"create":false,"update":false,"delete":false},"positions":{"view":false,"create":false,"update":false,"delete":false},"system_users":{"view":false,"create":false,"update":false,"delete":false},"projects":{"view":false,"create":false,"update":false,"delete":false},"audit_log":{"view":false,"create":false,"update":false,"delete":false},"access_rights":{"view":false,"create":false,"update":false,"delete":false},"project_employees":{"view":true,"create":false,"update":false,"delete":false},"project_equipment":{"view":true,"create":false,"update":false,"delete":false},"project_directories":{"view":true,"create":false,"update":false,"delete":false}}'::jsonb,'foreman')
ON CONFLICT(legacy_role_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO custom_roles(name,name_key,base_role,permissions,legacy_role_key)
VALUES('Инженер','инженер','engineer','{"workers_report":{"view":true,"create":true,"update":true,"delete":true},"equipment_report":{"view":true,"create":true,"update":true,"delete":true},"workers_timesheet":{"view":true,"create":true,"update":true,"delete":true},"equipment_timesheet":{"view":true,"create":true,"update":true,"delete":true},"employees":{"view":true,"create":true,"update":true,"delete":true},"equipment_registry":{"view":true,"create":true,"update":true,"delete":true},"positions":{"view":true,"create":false,"update":false,"delete":false},"system_users":{"view":true,"create":false,"update":false,"delete":false},"projects":{"view":true,"create":false,"update":false,"delete":false},"audit_log":{"view":true,"create":false,"update":false,"delete":false},"access_rights":{"view":true,"create":false,"update":false,"delete":false},"project_employees":{"view":true,"create":true,"update":true,"delete":true},"project_equipment":{"view":true,"create":true,"update":true,"delete":true},"project_directories":{"view":true,"create":true,"update":true,"delete":true}}'::jsonb,'engineer')
ON CONFLICT(legacy_role_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO custom_roles(name,name_key,base_role,permissions,legacy_role_key)
VALUES('Просмотр','просмотр','viewer','{"workers_report":{"view":true,"create":false,"update":false,"delete":false},"equipment_report":{"view":true,"create":false,"update":false,"delete":false},"workers_timesheet":{"view":true,"create":false,"update":false,"delete":false},"equipment_timesheet":{"view":true,"create":false,"update":false,"delete":false},"employees":{"view":false,"create":false,"update":false,"delete":false},"equipment_registry":{"view":false,"create":false,"update":false,"delete":false},"positions":{"view":false,"create":false,"update":false,"delete":false},"system_users":{"view":false,"create":false,"update":false,"delete":false},"projects":{"view":false,"create":false,"update":false,"delete":false},"audit_log":{"view":false,"create":false,"update":false,"delete":false},"access_rights":{"view":false,"create":false,"update":false,"delete":false},"project_employees":{"view":false,"create":false,"update":false,"delete":false},"project_equipment":{"view":false,"create":false,"update":false,"delete":false},"project_directories":{"view":false,"create":false,"update":false,"delete":false}}'::jsonb,'viewer')
ON CONFLICT(legacy_role_key) DO NOTHING;
--> statement-breakpoint
-- Save legacy scopes before linking users, without widening existing explicit grants.
WITH inserted AS (
  INSERT INTO user_project_access(user_id,all_projects,can_view_pending_reports)
  SELECT id,CASE WHEN role='engineer' THEN 1 ELSE 0 END,CASE WHEN role='viewer' THEN 0 ELSE 1 END
  FROM app_users WHERE custom_role_id IS NULL AND role IN ('foreman','engineer','viewer')
  ON CONFLICT(user_id) DO NOTHING RETURNING user_id
)
INSERT INTO user_project_access_sites(user_id,site_id)
SELECT u.id,u.assigned_site_id FROM app_users u JOIN inserted i ON i.user_id=u.id
JOIN sites s ON s.id=u.assigned_site_id AND s.active=1 WHERE u.role='foreman'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE app_users u SET custom_role_id=r.id FROM custom_roles r
WHERE u.custom_role_id IS NULL AND u.role=r.legacy_role_key AND r.active=1;
