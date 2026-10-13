-- Profiles are declared in ocd.jsonc (see config.ts); tasks keep their own
-- profile snapshot. The repo verify command was removed.
DROP TABLE `profiles`;--> statement-breakpoint
ALTER TABLE `repositories` DROP COLUMN `verify_command`;