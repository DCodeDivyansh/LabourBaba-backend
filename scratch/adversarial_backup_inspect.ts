import { execSync } from 'child_process';
import fs from 'fs';

function inspectBackupArtifact() {
  console.log('=== INSPECTING COMMITTED BACKUP ARTIFACT ===');
  const sql = execSync('git show dd6a3bc8060dc3e4350c1f6928929588490a912a:backups/backup_2026-09-22T09-46-12-254Z.sql', {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });

  const lines = sql.split('\n');
  const tableCounts: Record<string, number> = {};

  for (const line of lines) {
    const match = line.match(/INSERT INTO\s+"([^"]+)"/);
    if (match) {
      const table = match[1];
      tableCounts[table] = (tableCounts[table] || 0) + 1;
    }
  }

  console.log('Total Lines in Committed SQL:', lines.length);
  console.log('Tables and Insert Counts:');
  console.log(JSON.stringify(tableCounts, null, 2));

  // Determine what data types are present without exposing actual values
  const hasPhone = /phone/i.test(sql);
  const hasPassword = /password|hash/i.test(sql);
  const hasToken = /token/i.test(sql);
  const hasAadhaar = /aadhaar/i.test(sql);
  const hasLocation = /location|ST_SetSRID|POINT/i.test(sql);

  console.log('\nData Classification Findings:');
  console.log('  Customer/Worker Phone Numbers:', hasPhone);
  console.log('  Password / Auth Hashes:', hasPassword);
  console.log('  Session / Device Tokens:', hasToken);
  console.log('  Aadhaar / PII metadata:', hasAadhaar);
  console.log('  GPS / PostGIS Location Data:', hasLocation);
}

inspectBackupArtifact();
