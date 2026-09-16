import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const SERVICE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
