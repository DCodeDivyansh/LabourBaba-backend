import fs from 'fs';
import path from 'path';

describe('Issue #35: Docker Hardening & Multi-Stage Configuration', () => {
  const dockerfilePath = path.join(__dirname, '../Dockerfile');
  const dockerignorePath = path.join(__dirname, '../.dockerignore');
  const dockerComposePath = path.join(__dirname, '../docker-compose.yml');

  test('Dockerfile uses pinned Node version base image and multi-stage build', () => {
    expect(fs.existsSync(dockerfilePath)).toBe(true);
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    // Multi-stage builder & runner separation
    expect(dockerfile).toMatch(/FROM\s+node:22-alpine\s+AS\s+builder/i);
    expect(dockerfile).toMatch(/FROM\s+node:22-alpine\s+AS\s+runner/i);
  });

  test('Dockerfile uses deterministic npm ci for build', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toContain('npm ci');
    expect(dockerfile).not.toMatch(/RUN\s+npm\s+install(?!\s+--)/);
  });

  test('Dockerfile prunes development dependencies before runner stage', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toMatch(/npm\s+prune\s+--omit=dev/);
  });

  test('Dockerfile enforces non-root user execution in runtime container', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toMatch(/addgroup\s+-g\s+1001\s+-S\s+nodejs/);
    expect(dockerfile).toMatch(/adduser\s+-S\s+nodejs\s+-u\s+1001/);
    expect(dockerfile).toMatch(/USER\s+nodejs/);
  });

  test('Dockerfile defines a HEALTHCHECK instruction against /health endpoint', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/health');
  });

  test('.dockerignore excludes sensitive files, tests, docs, and git metadata', () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
    const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');

    expect(dockerignore).toContain('.git');
    expect(dockerignore).toContain('.env');
    expect(dockerignore).toContain('node_modules');
    expect(dockerignore).toContain('coverage');
    expect(dockerignore).toContain('tests');
    expect(dockerignore).toContain('docs');
    expect(dockerignore).toContain('scratch');
  });

  test('docker-compose pins database image to PostGIS compatible version', () => {
    expect(fs.existsSync(dockerComposePath)).toBe(true);
    const compose = fs.readFileSync(dockerComposePath, 'utf8');

    expect(compose).toMatch(/image:\s+postgis\/postgis:17-3\.5/);
    expect(compose).not.toContain('image: postgres:latest');
    expect(compose).not.toContain('image: postgis/postgis:latest');
  });
});
