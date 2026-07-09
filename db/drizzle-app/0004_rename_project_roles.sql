-- Data migration (no schema change): rename project_member role values to
-- capability-oriented names. 'member' (read+write) → 'write'; 'viewer'
-- (read-only) → 'read'. 'admin' is unchanged. The role column is plain TEXT
-- (the enum is enforced in application code only), so no DDL is required.
UPDATE `project_member` SET `role` = 'write' WHERE `role` = 'member';--> statement-breakpoint
UPDATE `project_member` SET `role` = 'read' WHERE `role` = 'viewer';
