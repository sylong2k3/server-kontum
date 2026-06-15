const fs = require('fs');
const path = require('path');
const { pool } = require('../configs/database');

const migrationsDir = path.join(__dirname, 'migrations');

const ensureMigrationsTable = async () => {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS core;

    CREATE TABLE IF NOT EXISTS core.schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const getExecutedMigrations = async () => {
  const { rows } = await pool.query('SELECT filename FROM core.schema_migrations ORDER BY filename');
  return new Set(rows.map((row) => row.filename));
};

const getMigrationFiles = () => fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const showStatus = async () => {
  await ensureMigrationsTable();
  const executed = await getExecutedMigrations();
  const files = getMigrationFiles();

  console.log('Migration status:');
  files.forEach((file) => {
    console.log(`${executed.has(file) ? '[x]' : '[ ]'} ${file}`);
  });
};

const runMigrations = async () => {
  await ensureMigrationsTable();
  const executed = await getExecutedMigrations();
  const files = getMigrationFiles();

  for (const file of files) {
    if (executed.has(file)) {
      console.log(`skip ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO core.schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`done ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`failed ${file}: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }
};

const main = async () => {
  try {
    if (process.argv.includes('--status')) {
      await showStatus();
    } else {
      await runMigrations();
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
