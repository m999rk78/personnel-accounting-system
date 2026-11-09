ALTER TABLE "bitrix24_employee_check_states"
  DROP CONSTRAINT IF EXISTS "bitrix24_employee_check_status_valid";
--> statement-breakpoint
ALTER TABLE "bitrix24_employee_check_states"
  ADD CONSTRAINT "bitrix24_employee_check_status_valid"
  CHECK ("status" IN ('mismatch', 'missing_in_bitrix', 'dismissed_in_bitrix', 'blacklisted_in_bitrix'));
