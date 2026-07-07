-- Data backfill (no schema change). Preserve pre-RBAC behavior: every org member
-- with role='member' previously had full read/write on all projects in the org.
-- Grant an explicit whole-project 'member' role per (member, project). Org admins
-- keep implicit full access via org-admin ability rules, so no row is created for them.
INSERT INTO `project_member` (`id`, `project_id`, `user_id`, `environment_id`, `role`, `created_at`)
SELECT lower(hex(randomblob(16))), p.`id`, om.`user_id`, NULL, 'member', unixepoch() * 1000
FROM `org_member` om
JOIN `project` p ON p.`org_id` = om.`org_id`
WHERE om.`role` = 'member';
