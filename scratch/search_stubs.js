const fs = require('fs');
const path = require('path');

const patterns = [
  'TODO',
  'FIXME',
  'NotImplemented',
  'not implemented',
  'placeholder',
  'fake',
  'dummy',
  'stub',
  'mock',
  'throw new Error'
];

const results = [];

function searchDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
        searchDir(fullPath);
      }
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const p of patterns) {
          if (line.toLowerCase().includes(p.toLowerCase())) {
            // Ignore test files or self
            if (!fullPath.includes('tests') && !fullPath.includes('scratch')) {
              results.push({
                pattern: p,
                file: path.relative(process.cwd(), fullPath),
                line: idx + 1,
                content: line.trim()
              });
            }
          }
        }
      });
    }
  }
}

searchDir(path.resolve(__dirname, '../src'));

console.log(`Found ${results.length} occurrences in src/`);
fs.writeFileSync('scratch/stubs_found.json', JSON.stringify(results, null, 2));
console.log('Saved to scratch/stubs_found.json');
