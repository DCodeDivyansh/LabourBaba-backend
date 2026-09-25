module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  verbose: true,
  forceExit: true,
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
  // setupFilesAfterEnv runs inside the worker AFTER the framework is
  // initialised, once per test file.  It resets the IORedis singleton so
  // each suite starts with a live connection (D-003 fix).
  setupFilesAfterEnv: ['<rootDir>/tests/setupRedisReset.ts'],
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  // 30-second timeout to accommodate real-PostgreSQL concurrency tests (N=100)
  testTimeout: 30000,
};
