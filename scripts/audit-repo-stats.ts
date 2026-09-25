import fs from 'fs';
import path from 'path';

function walk(dir: string, ext: string[]): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(fullPath, ext));
    } else {
      if (ext.some(e => file.endsWith(e))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function main() {
  const srcFiles = walk('src', ['.ts', '.js']);
  const testFiles = walk('tests', ['.ts', '.js']);
  const scriptFiles = walk('scripts', ['.ts', '.js']);
  
  const migrationDir = 'prisma/migrations';
  const migrations = fs.existsSync(migrationDir)
    ? fs.readdirSync(migrationDir).filter(f => fs.statSync(path.join(migrationDir, f)).isDirectory())
    : [];

  const schemaContent = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const models = [...schemaContent.matchAll(/^model\s+(\w+)\s+\{/gm)].map(m => m[1]);
  const enums = [...schemaContent.matchAll(/^enum\s+(\w+)\s+\{/gm)].map(m => m[1]);

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const prodDeps = Object.keys(pkg.dependencies || {});
  const devDeps = Object.keys(pkg.devDependencies || {});

  const stats = {
    sourceFilesCount: srcFiles.length,
    testFilesCount: testFiles.length,
    scriptFilesCount: scriptFiles.length,
    migrationsCount: migrations.length,
    migrationsList: migrations,
    prismaModelsCount: models.length,
    prismaModelsList: models,
    prismaEnumsCount: enums.length,
    prismaEnumsList: enums,
    prodDependenciesCount: prodDeps.length,
    devDependenciesCount: devDeps.length,
    totalDependenciesCount: prodDeps.length + devDeps.length,
    srcFiles,
    testFiles
  };

  fs.writeFileSync('artifacts/production-verification/build/repo_stats.json', JSON.stringify(stats, null, 2), 'utf8');
  console.log(`Inventory Summary:
- Source Files: ${srcFiles.length}
- Test Files: ${testFiles.length}
- Script Files: ${scriptFiles.length}
- Migrations: ${migrations.length}
- Prisma Models: ${models.length}
- Prisma Enums: ${enums.length}
- Prod Dependencies: ${prodDeps.length}
- Dev Dependencies: ${devDeps.length}`);
}

main();
