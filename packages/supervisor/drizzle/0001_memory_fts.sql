-- Custom, hand-reviewed migration: full-text search over memories and the
-- single-active-manager invariant. Drizzle Kit does not model these.

CREATE VIRTUAL TABLE `memories_fts` USING fts5(
	`content`,
	content = 'memories',
	content_rowid = 'seq',
	tokenize = 'porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `memories_fts_ai` AFTER INSERT ON `memories` BEGIN
	INSERT INTO `memories_fts` (rowid, content) VALUES (new.seq, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_ad` AFTER DELETE ON `memories` BEGIN
	INSERT INTO `memories_fts` (`memories_fts`, rowid, content) VALUES ('delete', old.seq, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_au` AFTER UPDATE OF `content` ON `memories` BEGIN
	INSERT INTO `memories_fts` (`memories_fts`, rowid, content) VALUES ('delete', old.seq, old.content);
	INSERT INTO `memories_fts` (rowid, content) VALUES (new.seq, new.content);
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `managers_single_active_idx` ON `managers` (`active`) WHERE `active` = 1;
