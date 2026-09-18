module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  verbose: true,
  forceExit: true,
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
