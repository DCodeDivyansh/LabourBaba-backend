/**
 * dockerProductionBootVerification.test.ts
 *
 * LabourBaba Backend — P6 Issue 10 Regression Suite:
 * Production Docker Image Is Boot-Tested by CI
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { initializeApp, cert, getApps, deleteApp } from 'firebase-admin/app';

describe('P6 Issue 10 — Production Docker Boot Verification & Hardening', () => {
  const rootDir = path.resolve(__dirname, '..');
  const ciWorkflowPath = path.resolve(rootDir, '.github', 'workflows', 'ci.yml');
  const dockerfilePath = path.resolve(rootDir, 'Dockerfile');
  const serverPath = path.resolve(rootDir, 'src', 'server.ts');
  const scriptTsPath = path.resolve(rootDir, 'scripts', 'verify-production-docker-boot.ts');
  const scriptShPath = path.resolve(rootDir, 'scripts', 'verify-production-docker-boot.sh');
  const packageJsonPath = path.resolve(rootDir, 'package.json');

  afterAll(async () => {
    for (const app of getApps()) {
      await deleteApp(app);
    }
  });

  describe('1. Server Interface Binding', () => {
    it('ensures httpServer.listen explicitly binds to 0.0.0.0 for container networking', () => {
      const serverCode = fs.readFileSync(serverPath, 'utf-8');
      expect(serverCode).toMatch(/httpServer\.listen\(\s*port,\s*["']0\.0\.0\.0["']/);
    });
  });

  describe('2. Dockerfile Production Invariants', () => {
    it('preserves multi-stage build with pinned Node 22 Alpine', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfile).toMatch(/FROM\s+node:22-alpine\s+AS\s+builder/i);
      expect(dockerfile).toMatch(/FROM\s+node:22-alpine\s+AS\s+runner/i);
    });

    it('enforces non-root user execution in runtime container', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfile).toMatch(/addgroup\s+-g\s+1001\s+-S\s+nodejs/);
      expect(dockerfile).toMatch(/adduser\s+-S\s+nodejs\s+-u\s+1001/);
      expect(dockerfile).toMatch(/USER\s+nodejs/);
    });

    it('prunes development dependencies and includes compiled dist', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfile).toContain('npm prune --omit=dev');
      expect(dockerfile).toMatch(/COPY\s+--from=builder\s+--chown=nodejs:nodejs\s+\/app\/dist\s+\.\/dist/);
      expect(dockerfile).toMatch(/CMD\s+\["node",\s+"dist\/server\.js"\]/);
    });

    it('configures native HEALTHCHECK targeting /health/ready', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfile).toContain('HEALTHCHECK');
      expect(dockerfile).toContain('/health/ready');
      expect(dockerfile).toContain('EXPOSE 5000');
    });
  });

  describe('3. CI Workflow Production Gate Integration', () => {
    it('ensures build-and-artifact-gate invokes npm run test:docker-boot after docker build', () => {
      const ciContent = fs.readFileSync(ciWorkflowPath, 'utf-8');
      expect(ciContent).toContain('npm run test:docker-boot');
      expect(ciContent).toContain('DOCKER_IMAGE_TAG: labourbaba-backend:test');
      expect(ciContent).toContain('Verify Production Docker Image Boot');
    });

    it('captures diagnostic container logs and uploads artifacts on failure', () => {
      const ciContent = fs.readFileSync(ciWorkflowPath, 'utf-8');
      expect(ciContent).toContain('docker-boot-failure-logs');
      expect(ciContent).toContain('docker logs labourbaba-ci-backend');
      expect(ciContent).toContain('docker logs labourbaba-ci-postgres');
      expect(ciContent).toContain('docker logs labourbaba-ci-redis');
    });

    it('defines test:docker-boot in package.json', () => {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      expect(packageJson.scripts['test:docker-boot']).toBeDefined();
      expect(packageJson.scripts['test:docker-boot']).toContain('verify-production-docker-boot.ts');
    });
  });

  describe('4. Boot Verification Script Architecture & Invariants', () => {
    it('ensures verify-production-docker-boot.ts and shell wrapper exist', () => {
      expect(fs.existsSync(scriptTsPath)).toBe(true);
      expect(fs.existsSync(scriptShPath)).toBe(true);
    });

    it('verifies script enforces real PostgreSQL and Redis dependencies', () => {
      const scriptCode = fs.readFileSync(scriptTsPath, 'utf-8');
      expect(scriptCode).toContain('postgis/postgis:17-3.5');
      expect(scriptCode).toContain('redis:7');
      expect(scriptCode).toContain('prisma migrate deploy');
    });

    it('verifies script checks /health/live and /health/ready endpoints', () => {
      const scriptCode = fs.readFileSync(scriptTsPath, 'utf-8');
      expect(scriptCode).toContain('/health/live');
      expect(scriptCode).toContain('/health/ready');
      expect(scriptCode).toContain("checks?.database === 'healthy'");
      expect(scriptCode).toContain("checks?.redis === 'healthy'");
    });

    it('verifies script includes negative readiness testing and recovery', () => {
      const scriptCode = fs.readFileSync(scriptTsPath, 'utf-8');
      expect(scriptCode).toContain('docker pause');
      expect(scriptCode).toContain('docker unpause');
      expect(scriptCode).toContain('503');
    });

    it('verifies script enqueues a real BullMQ job and waits for worker consumption', () => {
      const scriptCode = fs.readFileSync(scriptTsPath, 'utf-8');
      expect(scriptCode).toContain('notificationQueue.add');
      expect(scriptCode).toContain('testJob.getState()');
      expect(scriptCode).toContain('completed');
    });

    it('verifies script asserts graceful SIGTERM shutdown with exit code 0', () => {
      const scriptCode = fs.readFileSync(scriptTsPath, 'utf-8');
      expect(scriptCode).toContain('--signal=SIGTERM');
      expect(scriptCode).toContain('docker wait');
      expect(scriptCode).toContain('Initiating graceful shutdown via SIGTERM');
      expect(scriptCode).toContain('Graceful shutdown completed successfully');
    });

    it('verifies script inspects non-root container user and checks for secret leaks', () => {
      const scriptCode = fs.readFileSync(scriptTsPath, 'utf-8');
      expect(scriptCode).toContain("docker inspect -f '{{.Config.User}}'");
      expect(scriptCode).toContain('SECURITY VIOLATION: Plaintext secret detected in container logs');
    });
  });

  describe('5. Ephemeral Firebase Admin Credential Generation', () => {
    it('dynamically generates valid PKCS8 RSA credentials accepted by Firebase Admin SDK', () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const sa = {
        type: 'service_account',
        project_id: 'ci-test-project',
        private_key_id: 'key123',
        private_key: privateKey,
        client_email: 'ci-test@ci-test-project.iam.gserviceaccount.com',
      };

      const testApp = initializeApp({ credential: cert(sa as any) }, `test-app-${Date.now()}`);
      expect(testApp).toBeDefined();
      expect(testApp.name).toBeDefined();
    });
  });
});
