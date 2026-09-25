import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import prisma from '../src/config/prisma';
import { getRedisClient } from '../src/config/redis';

async function main() {
  const envData: Record<string, any> = {};

  // System & OS
  envData.os = `${os.type()} ${os.release()} (${os.arch()})`;
  envData.cpus = os.cpus().map(c => c.model);
  envData.cpuCount = os.cpus().length;
  envData.totalMemoryGB = +(os.totalmem() / (1024 ** 3)).toFixed(2);
  envData.freeMemoryGB = +(os.freemem() / (1024 ** 3)).toFixed(2);

  // Tools & Runtimes
  envData.nodeVersion = process.version;
  try { envData.npmVersion = execSync('npm -v', { encoding: 'utf8' }).trim(); } catch (e) { envData.npmVersion = 'N/A'; }
  try { envData.tscVersion = execSync('npx tsc -v', { encoding: 'utf8' }).trim(); } catch (e) { envData.tscVersion = 'N/A'; }
  try { envData.prismaVersion = execSync('npx prisma -v', { encoding: 'utf8' }).trim(); } catch (e) { envData.prismaVersion = 'N/A'; }
  try { envData.dockerVersion = execSync('docker -v', { encoding: 'utf8' }).trim(); } catch (e) { envData.dockerVersion = 'N/A'; }
  try { envData.dockerComposeVersion = execSync('docker compose version', { encoding: 'utf8' }).trim(); } catch (e) { envData.dockerComposeVersion = 'N/A'; }
  try { envData.gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch (e) { envData.gitCommit = 'N/A'; }

  // PostgreSQL & PostGIS Check
  try {
    const pgVersionRes: any = await prisma.$queryRawUnsafe(`SELECT version() as v;`);
    envData.postgresVersion = pgVersionRes[0]?.v;
  } catch (e: any) {
    envData.postgresVersion = `ERROR: ${e.message}`;
  }

  try {
    const postgisRes: any = await prisma.$queryRawUnsafe(`SELECT PostGIS_Full_Version() as v;`);
    envData.postgisVersion = postgisRes[0]?.v;
  } catch (e: any) {
    envData.postgisVersion = `PostGIS error: ${e.message}`;
  }

  // Redis Check
  try {
    const redis = getRedisClient();
    const redisInfo = await Promise.race([
      redis.info('server'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Redis timeout after 4s')), 4000))
    ]);
    const match = redisInfo.match(/redis_version:([^\r\n]+)/);
    envData.redisVersion = match ? match[1] : 'Unknown';
    envData.redisPing = await redis.ping();
  } catch (e: any) {
    envData.redisConfiguredError = e.message;
    // Check local Docker Redis fallback
    try {
      const IORedis = require('ioredis');
      const local = new IORedis({ host: '127.0.0.1', port: 6381, connectTimeout: 3000, maxRetriesPerRequest: 1 });
      const info = await local.info('server');
      const match = info.match(/redis_version:([^\r\n]+)/);
      envData.redisDockerLocal = {
        version: match ? match[1] : 'Unknown',
        port: 6381,
        ping: await local.ping()
      };
      await local.quit();
    } catch (localErr: any) {
      envData.redisDockerLocal = `Failed: ${localErr.message}`;
    }
  }

  envData.timestamp = new Date().toISOString();

  const report = JSON.stringify(envData, null, 2);
  fs.writeFileSync('artifacts/production-verification/environment/env_info.json', report, 'utf8');
  console.log(report);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
