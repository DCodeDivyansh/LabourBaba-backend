import fs from 'fs';
import path from 'path';

describe('Issue #33: Standardize Prisma Production Migrations', () => {
  const migrationsDir = path.join(__dirname, '../prisma/migrations');
  const packageJsonPath = path.join(__dirname, '../package.json');

  test('all migrations directories follow standard versioned timestamp format', () => {
    expect(fs.existsSync(migrationsDir)).toBe(true);

    const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
    const migrationDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    expect(migrationDirs.length).toBeGreaterThanOrEqual(23);

    const timestampRegex = /^\d{14}_[a-z0-9_]+$/;
    for (const dir of migrationDirs) {
      expect(dir).toMatch(timestampRegex);
      const sqlPath = path.join(migrationsDir, dir, 'migration.sql');
      expect(fs.existsSync(sqlPath)).toBe(true);
      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      expect(sqlContent.trim().length).toBeGreaterThan(0);
    }
  });

  test('migration order is strictly ascending and deterministic', () => {
    const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
    const migrationDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const timestamps = migrationDirs.map((d) => d.split('_')[0]);
    const sortedTimestamps = [...timestamps].sort();

    expect(timestamps).toEqual(sortedTimestamps);
  });

  test('package.json contains standardized production migration scripts', () => {
    expect(fs.existsSync(packageJsonPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts['migrate:deploy']).toBe('prisma migrate deploy');
    expect(pkg.scripts['migrate:status']).toBe('prisma migrate status');
    expect(pkg.scripts['migrate:resolve']).toBe('prisma migrate resolve');
    expect(pkg.scripts['db:generate']).toBe('prisma generate');
  });

  test('migrations do not contain uncontrolled DROP DATABASE or table resets', () => {
    const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
    const migrationDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const dir of migrationDirs) {
      const sqlPath = path.join(migrationsDir, dir, 'migration.sql');
      const sqlContent = fs.readFileSync(sqlPath, 'utf8').toUpperCase();

      expect(sqlContent).not.toContain('DROP DATABASE');
      expect(sqlContent).not.toContain('TRUNCATE');
    }
  });
});
