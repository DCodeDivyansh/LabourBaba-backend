import prisma from '../src/config/prisma';
import fs from 'fs';

async function main() {
  const checkConstraints = await prisma.$queryRawUnsafe(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      cc.check_clause
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON tc.constraint_name = cc.constraint_name
    WHERE tc.constraint_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name;
  `);

  const uniqueConstraints = await prisma.$queryRawUnsafe(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
  `);

  const summary = {
    checkConstraints,
    uniqueConstraints
  };

  fs.writeFileSync(
    'artifacts/production-verification/database/pg_constraints_inventory.json',
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  console.log(`Discovered ${Array.isArray(checkConstraints) ? checkConstraints.length : 0} CHECK constraints and ${Array.isArray(uniqueConstraints) ? uniqueConstraints.length : 0} unique/pk constraint columns.`);
  console.log(JSON.stringify(checkConstraints, null, 2));

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
