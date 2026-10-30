ALTER TABLE subwork_types ADD COLUMN IF NOT EXISTS main_work_type_id integer REFERENCES main_work_types(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subwork_types_parent ON subwork_types(site_id, main_work_type_id) WHERE active = 1;
--> statement-breakpoint
-- Only infer a relationship when all historical uses agree. Ambiguous or unused
-- subtypes stay unassigned for explicit classification in the directory.
WITH uses AS (
  SELECT site_id, main_work_type_id, subwork_type_id FROM placement_entries
  UNION
  SELECT site_id, main_work_type_id, subwork_type_id FROM equipment_entries
  UNION
  SELECT report.site_id, row.main_work_type_id, row.subwork_type_id
    FROM personnel_report_rows row JOIN personnel_reports report ON report.id = row.report_id
), agreed AS (
  SELECT site_id, subwork_type_id, MIN(main_work_type_id) AS parent_id FROM uses
  WHERE main_work_type_id IS NOT NULL AND subwork_type_id IS NOT NULL
  GROUP BY site_id, subwork_type_id HAVING COUNT(DISTINCT main_work_type_id) = 1
)
UPDATE subwork_types child SET main_work_type_id = agreed.parent_id FROM agreed
JOIN main_work_types parent ON parent.id = agreed.parent_id AND parent.site_id = agreed.site_id AND parent.active = 1
WHERE child.id = agreed.subwork_type_id AND child.site_id = agreed.site_id AND child.main_work_type_id IS NULL;
