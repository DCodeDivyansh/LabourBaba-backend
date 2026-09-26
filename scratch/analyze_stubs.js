const data = require('./stubs_found.json');
const byPattern = {};
data.forEach(d => {
  byPattern[d.pattern] = (byPattern[d.pattern] || 0) + 1;
});
console.log('Pattern counts:', byPattern);

const interesting = data.filter(d => ['TODO', 'FIXME', 'NotImplemented', 'not implemented', 'placeholder', 'fake', 'dummy', 'stub'].includes(d.pattern));
console.log('\n--- Interesting occurrences (' + interesting.length + ') ---');
interesting.forEach(d => {
  console.log(`${d.pattern} in ${d.file}:${d.line} -> ${d.content}`);
});
