import { execSync } from 'child_process';
import { Client } from 'pg';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

async function runAdversarialAudit() {
  console.log('====================================================');
  console.log('ADVERSARIAL PROBE 1: DOCKER RUNTIME CHECK');
  console.log('====================================================');
  try {
    const dockerVer = execSync('docker --version', { encoding: 'utf8' });
    console.log('Docker CLI Output:', dockerVer.trim());
    try {
      const dockerInfo = execSync('docker info', { encoding: 'utf8' });
      console.log('Docker Daemon: RUNNING');
    } catch (daemonErr: any) {
      console.log('Docker Daemon: FAILED / NOT RUNNING:', daemonErr.message.split('\n')[0]);
    }
  } catch (err: any) {
    console.log('Docker CLI: NOT FOUND / BLOCKED:', err.message.split('\n')[0]);
  }

  console.log('\n====================================================');
  console.log('ADVERSARIAL PROBE 2: REAL POSTGRESQL & POSTGIS CHECK');
  console.log('====================================================');
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('DATABASE_URL is MISSING!');
  } else {
    // Mask password in DB URL for output
    const maskedDbUrl = dbUrl.replace(/:([^:@]+)@/, ':****@');
    console.log('Target DATABASE_URL:', maskedDbUrl);
    const pg = new Client({ connectionString: dbUrl });
    try {
      await pg.connect();
      const verRes = await pg.query('SELECT version();');
      console.log('PostgreSQL Version:', verRes.rows[0].version);

      const postgisRes = await pg.query('SELECT PostGIS_Full_Version();');
      console.log('PostGIS Version:', postgisRes.rows[0].postgis_full_version);

      const dbNameRes = await pg.query('SELECT current_database(), current_user, inet_server_addr(), inet_server_port();');
      console.log('Database Identity:', dbNameRes.rows[0]);

      // Check migration table
      const migRes = await pg.query('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;');
      console.log('Latest 5 Prisma Migrations:', migRes.rows);

      // Check constraints
      const chkRes = await pg.query(`
        SELECT conname, pg_get_constraintdef(c.oid) 
        FROM pg_constraint c 
        JOIN pg_class t ON c.conrelid = t.oid 
        WHERE t.relname IN ('job_requirement', 'booking', 'worker_document')
        AND contype = 'c';
      `);
      console.log('Active CHECK Constraints on critical models:', chkRes.rows);

      await pg.end();
    } catch (dbErr: any) {
      console.error('PostgreSQL Connection FAILED:', dbErr.message);
    }
  }

  console.log('\n====================================================');
  console.log('ADVERSARIAL PROBE 3: REAL REDIS CHECK');
  console.log('====================================================');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('REDIS_URL is MISSING!');
  } else {
    const maskedRedisUrl = redisUrl.replace(/:([^:@]+)@/, ':****@');
    console.log('Target REDIS_URL:', maskedRedisUrl);
    const redis = new Redis(redisUrl, { connectTimeout: 10000, lazyConnect: true });
    try {
      await redis.connect();
      const pong = await redis.ping();
      console.log('Redis Ping Response:', pong);
      const info = await redis.info('server');
      const lines = info.split('\r\n').filter(l => l.startsWith('redis_version:') || l.startsWith('os:') || l.startsWith('tcp_port:'));
      console.log('Redis Server Info:', lines.join(' | '));

      // Test real command, key, TTL, deletion
      const testKey = 'audit:adversarial:test:' + Date.now();
      await redis.set(testKey, 'probe_value', 'EX', 60);
      const val = await redis.get(testKey);
      const ttl = await redis.ttl(testKey);
      await redis.del(testKey);
      console.log(`Redis write/read/TTL test -> Value: ${val}, TTL: ${ttl}s, Cleaned: true`);

      await redis.quit();
    } catch (rErr: any) {
      console.error('Redis Probe FAILED:', rErr.message);
    }
  }

  console.log('\n====================================================');
  console.log('ADVERSARIAL PROBE 4: GIT HISTORY ARTIFACTS & SECRETS');
  console.log('====================================================');
  try {
    const gitLog = execSync('git log --all --full-history --diff-filter=A --summary -- "backups/*.sql"', { encoding: 'utf8' });
    console.log('Git Backup SQL Commits Found:\n', gitLog.trim());
  } catch (gErr: any) {
    console.log('Git Search Error:', gErr.message);
  }

  console.log('\n====================================================');
  console.log('ADVERSARIAL PROBE 5: DEPENDENCY AUDIT CHECK');
  console.log('====================================================');
  try {
    const auditOutput = execSync('npm audit --json', { encoding: 'utf8' });
    const auditData = JSON.parse(auditOutput);
    console.log('Total Vulnerabilities:', auditData.metadata?.vulnerabilities);
  } catch (auditErr: any) {
    if (auditErr.stdout) {
      try {
        const auditData = JSON.parse(auditErr.stdout);
        console.log('Total Vulnerabilities:', auditData.metadata?.vulnerabilities);
        const vulns = auditData.vulnerabilities || {};
        console.log('Vulnerable packages:', Object.keys(vulns).join(', '));
      } catch {
        console.log('npm audit exited with code:', auditErr.status);
      }
    } else {
      console.log('npm audit error:', auditErr.message);
    }
  }
}

runAdversarialAudit().catch(console.error);
