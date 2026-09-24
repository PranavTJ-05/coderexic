import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm db:generate`, which writes SQL migrations from the
// schema. Migrations are applied with `pnpm db:migrate`, never at startup.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
});
