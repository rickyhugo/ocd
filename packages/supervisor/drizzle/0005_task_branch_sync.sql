-- Branch-sync watchdog status per task (docs/branch-sync.md); null until checked.
ALTER TABLE `tasks` ADD `branch_sync` text;