UPDATE "app_users"
SET "role" = 'superadmin', "assigned_site_id" = NULL
WHERE "role" = 'office';
