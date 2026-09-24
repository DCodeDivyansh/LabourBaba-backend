import { execSync } from 'child_process';
import fs from 'fs';

function auditDependencies() {
  console.log('=== RUNNING INDEPENDENT NPM AUDIT ANALYSIS ===');
  let auditJsonStr = '';
  try {
    auditJsonStr = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (err: any) {
    if (err.stdout) {
      auditJsonStr = err.stdout;
    } else {
      console.error('Failed to run npm audit:', err.message);
      return;
    }
  }

  const data = JSON.parse(auditJsonStr);
  const metadata = data.metadata?.vulnerabilities || {};
  console.log('NPM Audit Vulnerability Metadata Count:');
  console.log(JSON.stringify(metadata, null, 2));

  const vulns = data.vulnerabilities || {};
  const entries: any[] = [];

  for (const [pkgName, detail] of Object.entries<any>(vulns)) {
    const via = Array.isArray(detail.via) ? detail.via : [detail.via];
    for (const v of via) {
      if (typeof v === 'object' && v !== null) {
        entries.push({
          package: pkgName,
          severity: v.severity || detail.severity,
          title: v.title,
          url: v.url,
          range: v.range,
          isDirect: detail.isDirect,
          effects: detail.effects,
          fixAvailable: detail.fixAvailable
        });
      } else if (typeof v === 'string') {
        entries.push({
          package: pkgName,
          severity: detail.severity,
          transitiveVia: v,
          isDirect: detail.isDirect,
          effects: detail.effects,
          fixAvailable: detail.fixAvailable
        });
      }
    }
  }

  console.log(`Total advisory entries parsed: ${entries.length}`);
  fs.writeFileSync('reports/adversarial-dependencies-audit.json', JSON.stringify(entries, null, 2));

  // Summary by package and severity
  const summary: Record<string, { severity: string; isDirect: boolean; count: number; titles: string[] }> = {};
  for (const e of entries) {
    if (!summary[e.package]) {
      summary[e.package] = { severity: e.severity, isDirect: !!e.isDirect, count: 0, titles: [] };
    }
    summary[e.package].count++;
    if (e.title && !summary[e.package].titles.includes(e.title)) {
      summary[e.package].titles.push(e.title);
    }
  }
  console.log('\nPackage Vulnerability Summary:');
  console.log(JSON.stringify(summary, null, 2));
}

auditDependencies();
