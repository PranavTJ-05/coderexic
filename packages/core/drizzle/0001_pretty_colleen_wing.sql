-- NULLS NOT DISTINCT is hand-added: drizzle-kit's `uniqueIndex` builder has
-- no API for it (only the separate table-level `unique()` constraint
-- builder exposes `.nullsNotDistinct()`, and that builder doesn't support a
-- partial WHERE clause). Without it, multiple NULL `repository_id` rows
-- (user-level, non-repo-scoped credentials) would each be treated as
-- distinct, letting duplicate live credentials exist for the same
-- (user, provider) pair.
CREATE UNIQUE INDEX "model_credentials_live_unique_idx" ON "model_credentials" USING btree ("user_id","repository_id","provider") NULLS NOT DISTINCT WHERE "model_credentials"."deleted_at" is null;
