import fs from 'fs';
import path from 'path';

describe('Issue #21 Architecture Guards: BullMQ Only Production Dispatch Engine', () => {
  const srcDir = path.resolve(__dirname, '../src');

  function getAllTsFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        getAllTsFiles(fullPath, fileList);
      } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  const allSrcFiles = getAllTsFiles(srcDir);

  it('MUST NOT have any production file importing simpleDispatch', () => {
    const violatingFiles: string[] = [];

    for (const file of allSrcFiles) {
      // simpleDispatch.ts itself is excluded from checking itself
      if (file.endsWith('simpleDispatch.ts')) continue;

      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('simpleDispatch') || content.includes('dispatchJobSimple')) {
        violatingFiles.push(path.relative(srcDir, file));
      }
    }

    expect(violatingFiles).toEqual([]);
  });

  it('MUST NOT use setTimeout or setInterval for dispatch timing in production dispatch code', () => {
    const dispatchFiles = allSrcFiles.filter(
      (f) =>
        f.includes('dispatch') &&
        !f.endsWith('simpleDispatch.ts') && // deprecated fixture
        !f.includes('worker_location')
    );

    const violatingFiles: Array<{ file: string; match: string }> = [];

    for (const file of dispatchFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        // Ignore comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (trimmed.includes('setTimeout') || trimmed.includes('setInterval')) {
          violatingFiles.push({
            file: `${path.relative(srcDir, file)}:${idx + 1}`,
            match: trimmed,
          });
        }
      });
    }

    expect(violatingFiles).toEqual([]);
  });

  it('MUST NOT contain in-process polling loops (while/sleep) for dispatch timing in production', () => {
    const dispatchFiles = allSrcFiles.filter(
      (f) => f.includes('dispatch') && !f.endsWith('simpleDispatch.ts')
    );

    const violatingFiles: Array<{ file: string; match: string }> = [];

    for (const file of dispatchFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('waitForAcceptanceOrTimeout') || content.includes('fastPollMs')) {
        violatingFiles.push({
          file: path.relative(srcDir, file),
          match: 'In-process acceptance polling found',
        });
      }
    }

    expect(violatingFiles).toEqual([]);
  });

  it('MUST throw a fatal architecture violation if simpleDispatch is loaded in production', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      // Reset module cache to re-execute top-level check
      const simpleDispatchPath = path.resolve(srcDir, 'features/dispatch/simpleDispatch.ts');
      jest.resetModules();
      expect(() => {
        require(simpleDispatchPath);
      }).toThrow(/FATAL_ARCHITECTURE_VIOLATION/);
    } finally {
      process.env.NODE_ENV = originalEnv;
      jest.resetModules();
    }
  });
});
