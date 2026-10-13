-- Repositories are declared in ocd.jsonc; rows stay for task history and are
-- retired when removed from the file.
ALTER TABLE `repositories` ADD `retired_at` text;