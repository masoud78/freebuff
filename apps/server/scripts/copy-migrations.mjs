// tsc does not copy .sql migration files into dist/. Copy them so the built
// server can run migrations from the same relative location as the source.
import { cpSync, existsSync } from 'node:fs';

const source = 'src/core/database/migrations';
const target = 'dist/core/database/migrations';

if (existsSync(source)) {
  cpSync(source, target, { recursive: true });
  console.log(`Copied migrations: ${source} -> ${target}`);
}
