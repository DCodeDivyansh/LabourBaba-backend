// scratch/analyze_109_failures.js
const fs = require('fs');

const fullResults = JSON.parse(fs.readFileSync('reports/phase11/jest-full-results.json', 'utf8'));

// Extract every failed assertion across all suites with full details
const failures = [];
fullResults.testResults.forEach(suite => {
  const suiteName = suite.name.replace(/\\/g, '/').split('/').pop();
  const suitePath = suite.name;
  (suite.assertionResults || []).forEach(test => {
    if (test.status === 'failed') {
      failures.push({
        suite: suiteName,
        suitePath: suitePath,
        testName: test.fullName,
        ancestorTitles: test.ancestorTitles,
        title: test.title,
        status: test.status,
        failureMessages: test.failureMessages,
        duration: test.duration,
      });
    }
  });
});

console.log('Total extracted failures:', failures.length);

// Group by suite
const bySuite = {};
failures.forEach((f, idx) => {
  bySuite[f.suite] = bySuite[f.suite] || [];
  bySuite[f.suite].push({ id: idx + 1, ...f });
});

console.log('\nSuites breakdown:');
let totalCheck = 0;
for (const [suite, list] of Object.entries(bySuite)) {
  console.log(`- ${suite}: ${list.length}`);
  totalCheck += list.length;
}
console.log('Total check sum:', totalCheck);

fs.writeFileSync('scratch/all_109_failures_detailed.json', JSON.stringify(failures, null, 2));
console.log('Wrote scratch/all_109_failures_detailed.json');
