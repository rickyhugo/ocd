import { defineConfig } from "drizzle-kit";

// Generates reviewed SQL migrations only. Never use `drizzle-kit push` against a
// user database; the supervisor applies checked-in migrations explicitly.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
