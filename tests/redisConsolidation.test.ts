import {
  getRedisConfig,
  getRedisConnectionOptions,
  assertRedisConfig,
  getRedisClient,
  closeRedisConnections
} from '../src/config/redis';

describe('Issue 37 - Redis Configuration Consolidation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    process.env = originalEnv;
    await closeRedisConnections();
  });

  describe('Configuration Parsing & Defaults', () => {
    it('parses valid rediss:// URL with TLS and authentication', () => {
      process.env.REDIS_URL = 'rediss://:mypassword@cache.example.com:6380';
      delete process.env.UPSTASH_REDIS_URL;

      const config = getRedisConfig();
      expect(config.host).toBe('cache.example.com');
      expect(config.port).toBe(6380);
      expect(config.password).toBe('mypassword');
      expect(config.tls).toBe(true);
    });

    it('parses standard redis:// URL without TLS', () => {
      process.env.REDIS_URL = 'redis://default:secretpass@10.0.0.5:6379';
      delete process.env.UPSTASH_REDIS_URL;

      const config = getRedisConfig();
      expect(config.host).toBe('10.0.0.5');
      expect(config.port).toBe(6379);
      expect(config.password).toBe('secretpass');
      expect(config.tls).toBeFalsy();
    });

    it('uses discrete environment variables if REDIS_URL is not set', () => {
      delete process.env.REDIS_URL;
      delete process.env.UPSTASH_REDIS_URL;
      process.env.REDIS_HOST = 'custom-redis.internal';
      process.env.REDIS_PORT = '6390';
      process.env.REDIS_PASSWORD = 'discrete-auth-token';
      process.env.REDIS_TLS = 'true';

      const config = getRedisConfig();
      expect(config.host).toBe('custom-redis.internal');
      expect(config.port).toBe(6390);
      expect(config.password).toBe('discrete-auth-token');
      expect(config.tls).toBe(true);
    });

    it('sets maxRetriesPerRequest to null for BullMQ compatibility', () => {
      const options = getRedisConnectionOptions();
      expect(options.maxRetriesPerRequest).toBeNull();
    });
  });

  describe('Production Validation & No-Localhost Invariant', () => {
    it('throws in production if REDIS_URL and REDIS_HOST are completely missing', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.REDIS_URL;
      delete process.env.UPSTASH_REDIS_URL;
      delete process.env.REDIS_HOST;

      expect(() => assertRedisConfig()).toThrow('Production requires a valid remote REDIS_URL or REDIS_HOST');
    });

    it('throws in production if configured with localhost / 127.0.0.1', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.UPSTASH_REDIS_URL;

      process.env.REDIS_URL = 'redis://localhost:6379';
      expect(() => assertRedisConfig()).toThrow('localhost/127.0.0.1 is prohibited');

      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      expect(() => assertRedisConfig()).toThrow('localhost/127.0.0.1 is prohibited');
    });

    it('passes assertRedisConfig in production with valid remote host and password', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.UPSTASH_REDIS_URL;
      process.env.REDIS_URL = 'rediss://:securepass123@prod-redis.domain.com:6380';

      expect(() => assertRedisConfig()).not.toThrow();
    });
  });

  describe('Client Lifecycle and Closing', () => {
    it('reuses singleton client and closes cleanly', async () => {
      process.env.NODE_ENV = 'test';
      const client1 = getRedisClient();
      const client2 = getRedisClient();
      expect(client1).toBe(client2);

      await expect(closeRedisConnections()).resolves.not.toThrow();
    });

    it('is idempotent when calling closeRedisConnections multiple times', async () => {
      await expect(closeRedisConnections()).resolves.not.toThrow();
      await expect(closeRedisConnections()).resolves.not.toThrow();
    });
  });
});
