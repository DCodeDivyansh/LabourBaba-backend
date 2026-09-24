import fs from 'fs';
import path from 'path';

interface TestAuditResult {
  file: string;
  hasPrismaMock: boolean;
  hasRealPrismaImport: boolean;
  hasPgClient: boolean;
  dbClassification: 'REAL_DB' | 'MOCKED_DB' | 'MIXED_DB' | 'NO_DB';
  hasRedisMock: boolean;
  hasRealRedis: boolean;
  redisClassification: 'REAL_REDIS' | 'MOCKED_REDIS' | 'NO_REDIS';
  hasBullmqMock: boolean;
  hasRealBullmqWorker: boolean;
  bullmqClassification: 'REAL_BULLMQ' | 'MOCKED_BULLMQ' | 'NO_BULLMQ';
  hasFcmMock: boolean;
  hasRealFcm: boolean;
  fcmClassification: 'REAL_FCM' | 'MOCKED_FCM' | 'NO_FCM';
  hasStorageMock: boolean;
  hasRealStorage: boolean;
  storageClassification: 'REAL_STORAGE' | 'MOCKED_STORAGE' | 'NO_STORAGE';
  concurrencyType: 'REAL_CONCURRENCY' | 'MOCKED_CONCURRENCY' | 'SEQUENTIAL_OR_NONE';
  failureInjectionType: 'REAL_FAILURE' | 'MOCKED_FAILURE' | 'STATIC_ASSERTION' | 'NONE';
  isAstStaticInspection: boolean;
  isLoadTest: boolean;
  loadType: 'REAL_LOAD' | 'DATA_VOLUME_FIXTURE' | 'NONE';
  evidenceSummary: string;
}

function auditTestFile(filePath: string): TestAuditResult {
  const content = fs.readFileSync(filePath, 'utf8');
  const baseName = path.basename(filePath);

  // Accurate Prisma Mock detection: matches jest.mock with prisma or @prisma/client anywhere
  const mocksPrisma = /jest\.mock\s*\(\s*['"][^'"]*prisma/i.test(content);
  const importsPrisma = /import\s+.*prisma.*from/i.test(content) || /require\(['"][^'"]*prisma/i.test(content);
  const usesPgClient = /new\s+(Client|Pool)\s*\(/i.test(content) || /pgClient\./i.test(content);
  const usesRawSql = /prisma\.\$queryRaw/i.test(content) || /prisma\.\$executeRaw/i.test(content);

  let dbClassification: 'REAL_DB' | 'MOCKED_DB' | 'MIXED_DB' | 'NO_DB' = 'NO_DB';
  if (mocksPrisma && usesPgClient) {
    dbClassification = 'MIXED_DB';
  } else if (mocksPrisma) {
    dbClassification = 'MOCKED_DB';
  } else if (usesPgClient || (importsPrisma && !mocksPrisma)) {
    dbClassification = 'REAL_DB';
  } else {
    dbClassification = 'NO_DB';
  }

  // Accurate Redis Mock detection
  const mocksRedis = /jest\.mock\s*\(\s*['"][^'"]*(redis|ioredis)/i.test(content);
  const usesRedisDirect = /getRedisClient\(\)/i.test(content) || /new\s+Redis\s*\(/i.test(content) || /sharedRedisClient/i.test(content);
  let redisClassification: 'REAL_REDIS' | 'MOCKED_REDIS' | 'NO_REDIS' = 'NO_REDIS';
  if (mocksRedis && usesRedisDirect) {
    redisClassification = 'MOCKED_REDIS';
  } else if (mocksRedis) {
    redisClassification = 'MOCKED_REDIS';
  } else if (usesRedisDirect) {
    redisClassification = 'REAL_REDIS';
  }

  // Accurate BullMQ Mock detection
  const mocksBullmq = /jest\.mock\s*\(\s*['"][^'"]*bullmq/i.test(content);
  const usesBullmqDirect = /new\s+Worker\s*\(/i.test(content) || /new\s+Queue\s*\(/i.test(content) || /dispatchQueue\./i.test(content);
  let bullmqClassification: 'REAL_BULLMQ' | 'MOCKED_BULLMQ' | 'NO_BULLMQ' = 'NO_BULLMQ';
  if (mocksBullmq) {
    bullmqClassification = 'MOCKED_BULLMQ';
  } else if (usesBullmqDirect) {
    bullmqClassification = 'REAL_BULLMQ';
  }

  // Accurate FCM Mock detection
  const mocksFcm = /jest\.mock\s*\(\s*['"][^'"]*(fcm|firebase-admin)/i.test(content) || 
                   /setMockFcmProvider/i.test(content);
  const usesFcmDirect = /sendFCMNotification/i.test(content) || /sendFCMToWorker/i.test(content) || /getFirebaseMessaging/i.test(content);
  let fcmClassification: 'REAL_FCM' | 'MOCKED_FCM' | 'NO_FCM' = 'NO_FCM';
  if (mocksFcm) {
    fcmClassification = 'MOCKED_FCM';
  } else if (usesFcmDirect) {
    fcmClassification = 'REAL_FCM';
  }

  // Accurate Storage Mock detection
  const mocksStorage = /jest\.mock\s*\(\s*['"][^'"]*storage/i.test(content);
  const usesStorageDirect = /storageService\./i.test(content) || /supabaseStorageDriver/i.test(content) || /storageController/i.test(content);
  let storageClassification: 'REAL_STORAGE' | 'MOCKED_STORAGE' | 'NO_STORAGE' = 'NO_STORAGE';
  if (mocksStorage) {
    storageClassification = 'MOCKED_STORAGE';
  } else if (usesStorageDirect) {
    storageClassification = 'REAL_STORAGE';
  }

  // Concurrency check: real simultaneous operations via Promise.all / Promise.allSettled
  const hasPromiseAll = /Promise\.(all|allSettled)\s*\(/i.test(content);
  let concurrencyType: 'REAL_CONCURRENCY' | 'MOCKED_CONCURRENCY' | 'SEQUENTIAL_OR_NONE' = 'SEQUENTIAL_OR_NONE';
  if (hasPromiseAll) {
    if (dbClassification === 'REAL_DB') {
      concurrencyType = 'REAL_CONCURRENCY';
    } else if (dbClassification === 'MOCKED_DB') {
      concurrencyType = 'MOCKED_CONCURRENCY';
    } else {
      concurrencyType = 'REAL_CONCURRENCY';
    }
  }

  // Failure injection check: real failure vs mocked rejection vs static
  const testsFailure = /catch/i.test(content) || /rejects\./i.test(content) || /expect\(res\.status\)\.toBe\((500|503|502|504|400|401|403|404|409|429)\)/i.test(content);
  let failureInjectionType: 'REAL_FAILURE' | 'MOCKED_FAILURE' | 'STATIC_ASSERTION' | 'NONE' = 'NONE';
  if (testsFailure) {
    if (/mockRejectedValue/i.test(content) || /mockImplementation.*throw/i.test(content) || /mockImplementation.*Error/i.test(content)) {
      failureInjectionType = 'MOCKED_FAILURE';
    } else if (dbClassification === 'REAL_DB' || redisClassification === 'REAL_REDIS') {
      failureInjectionType = 'REAL_FAILURE';
    } else {
      failureInjectionType = 'STATIC_ASSERTION';
    }
  }

  // AST / Static File Inspection check: opens source file using fs and asserts string/regex
  const isAstStaticInspection = /fs\.readFileSync/i.test(content) && (/toMatch\(/i.test(content) || /toContain\(/i.test(content) || /toHaveLength/i.test(content));

  // Load Test Check
  const isLoadTest = /10000|10k|soak|stress|capacity500|loadSoak/i.test(content);
  let loadType: 'REAL_LOAD' | 'DATA_VOLUME_FIXTURE' | 'NONE' = 'NONE';
  if (isLoadTest) {
    // If it executes HTTP requests or concurrent queries against real DB
    if (/request\(app\)/i.test(content) || (hasPromiseAll && dbClassification === 'REAL_DB')) {
      loadType = 'REAL_LOAD';
    } else {
      loadType = 'DATA_VOLUME_FIXTURE';
    }
  }

  return {
    file: baseName,
    hasPrismaMock: mocksPrisma,
    hasRealPrismaImport: importsPrisma,
    hasPgClient: usesPgClient,
    dbClassification,
    hasRedisMock: mocksRedis,
    hasRealRedis: usesRedisDirect,
    redisClassification,
    hasBullmqMock: mocksBullmq,
    hasRealBullmqWorker: usesBullmqDirect,
    bullmqClassification,
    hasFcmMock: mocksFcm,
    hasRealFcm: usesFcmDirect,
    fcmClassification,
    hasStorageMock: mocksStorage,
    hasRealStorage: usesStorageDirect,
    storageClassification,
    concurrencyType,
    failureInjectionType,
    isAstStaticInspection,
    isLoadTest,
    loadType,
    evidenceSummary: `DB: ${dbClassification}, Redis: ${redisClassification}, BullMQ: ${bullmqClassification}, FCM: ${fcmClassification}`
  };
}

const testsDir = path.resolve('tests');
const files = fs.readdirSync(testsDir).filter(f => f.endsWith('.test.ts'));
const results = files.map(f => auditTestFile(path.join(testsDir, f)));

const realDbTests = results.filter(r => r.dbClassification === 'REAL_DB').map(r => r.file);
const mockedDbTests = results.filter(r => r.dbClassification === 'MOCKED_DB').map(r => r.file);
const mixedDbTests = results.filter(r => r.dbClassification === 'MIXED_DB').map(r => r.file);
const noDbTests = results.filter(r => r.dbClassification === 'NO_DB').map(r => r.file);

const realRedisTests = results.filter(r => r.redisClassification === 'REAL_REDIS').map(r => r.file);
const mockedRedisTests = results.filter(r => r.redisClassification === 'MOCKED_REDIS').map(r => r.file);
const noRedisTests = results.filter(r => r.redisClassification === 'NO_REDIS').map(r => r.file);

const realBullmqTests = results.filter(r => r.bullmqClassification === 'REAL_BULLMQ').map(r => r.file);
const mockedBullmqTests = results.filter(r => r.bullmqClassification === 'MOCKED_BULLMQ').map(r => r.file);
const noBullmqTests = results.filter(r => r.bullmqClassification === 'NO_BULLMQ').map(r => r.file);

const realFcmTests = results.filter(r => r.fcmClassification === 'REAL_FCM').map(r => r.file);
const mockedFcmTests = results.filter(r => r.fcmClassification === 'MOCKED_FCM').map(r => r.file);
const noFcmTests = results.filter(r => r.fcmClassification === 'NO_FCM').map(r => r.file);

const realStorageTests = results.filter(r => r.storageClassification === 'REAL_STORAGE').map(r => r.file);
const mockedStorageTests = results.filter(r => r.storageClassification === 'MOCKED_STORAGE').map(r => r.file);
const noStorageTests = results.filter(r => r.storageClassification === 'NO_STORAGE').map(r => r.file);

const realConcurrencyTests = results.filter(r => r.concurrencyType === 'REAL_CONCURRENCY').map(r => r.file);
const mockedConcurrencyTests = results.filter(r => r.concurrencyType === 'MOCKED_CONCURRENCY').map(r => r.file);
const nonConcurrencyTests = results.filter(r => r.concurrencyType === 'SEQUENTIAL_OR_NONE').map(r => r.file);

const realFailureTests = results.filter(r => r.failureInjectionType === 'REAL_FAILURE').map(r => r.file);
const mockedFailureTests = results.filter(r => r.failureInjectionType === 'MOCKED_FAILURE').map(r => r.file);
const staticFailureTests = results.filter(r => r.failureInjectionType === 'STATIC_ASSERTION').map(r => r.file);

const realLoadTests = results.filter(r => r.loadType === 'REAL_LOAD').map(r => r.file);
const fixtureVolumeTests = results.filter(r => r.loadType === 'DATA_VOLUME_FIXTURE').map(r => r.file);

const staticTests = results.filter(r => r.isAstStaticInspection).map(r => r.file);

const summary = {
  totalTestFiles: results.length,
  counts: {
    realDbTests: realDbTests.length,
    mockedDbTests: mockedDbTests.length,
    mixedDbTests: mixedDbTests.length,
    noDbTests: noDbTests.length,
    realRedisTests: realRedisTests.length,
    mockedRedisTests: mockedRedisTests.length,
    noRedisTests: noRedisTests.length,
    realBullmqTests: realBullmqTests.length,
    mockedBullmqTests: mockedBullmqTests.length,
    noBullmqTests: noBullmqTests.length,
    realFcmTests: realFcmTests.length,
    mockedFcmTests: mockedFcmTests.length,
    noFcmTests: noFcmTests.length,
    realStorageTests: realStorageTests.length,
    mockedStorageTests: mockedStorageTests.length,
    noStorageTests: noStorageTests.length,
    realConcurrencyTests: realConcurrencyTests.length,
    mockedConcurrencyTests: mockedConcurrencyTests.length,
    nonConcurrencyTests: nonConcurrencyTests.length,
    realFailureTests: realFailureTests.length,
    mockedFailureTests: mockedFailureTests.length,
    staticFailureTests: staticFailureTests.length,
    realLoadTests: realLoadTests.length,
    fixtureVolumeTests: fixtureVolumeTests.length,
    staticTests: staticTests.length
  },
  realDbTests,
  mockedDbTests,
  mixedDbTests,
  noDbTests,
  realRedisTests,
  mockedRedisTests,
  realBullmqTests,
  mockedBullmqTests,
  realFcmTests,
  mockedFcmTests,
  realStorageTests,
  mockedStorageTests,
  realConcurrencyTests,
  mockedConcurrencyTests,
  realFailureTests,
  mockedFailureTests,
  staticFailureTests,
  realLoadTests,
  fixtureVolumeTests,
  staticTests
};

fs.writeFileSync('reports/adversarial-classification.json', JSON.stringify(summary, null, 2));
console.log('ADVERSARIAL TEST CLASSIFICATION AUDIT RESULTS:');
console.log(JSON.stringify(summary.counts, null, 2));
