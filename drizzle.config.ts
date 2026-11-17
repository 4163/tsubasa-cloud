import { defineConfig } from 'drizzle-kit';

// Drizzle Kit config for schema inspection. Runtime DDL and migrations live in src/server/db/init.ts and must stay synchronized with src/server/db/schema.ts.
export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/tsubasa.db',
  },
});

