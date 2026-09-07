const fs = require('node:fs');
const path = require('node:path');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`EduLink requires Node.js 22.5 or newer. Current version: ${process.version}`);
  process.exit(1);
}

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const mode = process.argv[2] || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
if (!['postgres', 'sqlite'].includes(mode)) {
  console.error('Usage: node start.js [postgres|sqlite]');
  process.exit(1);
}
if (mode === 'postgres' && !process.env.DATABASE_URL) {
  console.error('PostgreSQL requires DATABASE_URL. Copy .env.example to .env and configure it, or use npm run start:sqlite for the demo.');
  process.exit(1);
}

if (mode === 'sqlite') {
  console.warn('EduLink: SQLite demo mode. Group and course administration requires PostgreSQL (DATABASE_URL).');
}
require(mode === 'postgres' ? './server-pg' : './server');
