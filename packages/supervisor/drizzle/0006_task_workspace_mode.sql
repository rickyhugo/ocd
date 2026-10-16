-- Workspace mode chosen at dispatch; every earlier task had its own worktree.
ALTER TABLE `tasks` ADD `workspace_mode` text DEFAULT 'isolated' NOT NULL;
