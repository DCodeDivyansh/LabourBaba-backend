import fs from 'fs';

function main() {
  const readCleanJson = (path: string) => {
    let raw = fs.readFileSync(path, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
    }
    return JSON.parse(raw);
  };
  const prod = readCleanJson('artifacts/production-verification/security/npm_audit_prod.json');
  const all = readCleanJson('artifacts/production-verification/security/npm_audit_all.json');

  console.log('--- NPM AUDIT (PROD ONLY) ---');
  console.log('Metadata:', JSON.stringify(prod.metadata?.vulnerabilities || prod.vulnerabilities, null, 2));

  console.log('--- NPM AUDIT (ALL INCLUDING DEV) ---');
  console.log('Metadata:', JSON.stringify(all.metadata?.vulnerabilities || all.vulnerabilities, null, 2));

  if (prod.vulnerabilities && Object.keys(prod.vulnerabilities).length > 0) {
    console.log('Production Vulnerabilities Detail:');
    for (const [pkg, details] of Object.entries(prod.vulnerabilities)) {
      console.log(`- Package: ${pkg}, Severity: ${(details as any).severity}, Via: ${JSON.stringify((details as any).via)}`);
    }
  } else {
    console.log('Zero production vulnerabilities found.');
  }

  if (all.vulnerabilities && Object.keys(all.vulnerabilities).length > 0) {
    console.log('Dev/All Vulnerabilities Detail:');
    for (const [pkg, details] of Object.entries(all.vulnerabilities)) {
      if (!prod.vulnerabilities || !prod.vulnerabilities[pkg]) {
        console.log(`- Dev/Build/Test Package: ${pkg}, Severity: ${(details as any).severity}, Via: ${JSON.stringify((details as any).via)}`);
      }
    }
  }
}

main();
