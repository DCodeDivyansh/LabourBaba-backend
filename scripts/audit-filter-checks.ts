import fs from 'fs';

const data = JSON.parse(fs.readFileSync('artifacts/production-verification/database/pg_constraints_inventory.json', 'utf8'));
const domainChecks = data.checkConstraints.filter((c: any) => !c.constraint_name.includes('_not_null'));
console.log('Domain CHECK constraints in PostgreSQL:');
console.log(JSON.stringify(domainChecks, null, 2));

const uniqueList = data.uniqueConstraints;
console.log(`\nUnique / Primary constraints count: ${uniqueList.length}`);
fs.writeFileSync('artifacts/production-verification/database/domain_checks_summary.json', JSON.stringify(domainChecks, null, 2), 'utf8');
