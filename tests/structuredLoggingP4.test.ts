import { logger, redactSensitiveData } from '../src/utils/logger';
import { runWithRequestContext, getCorrelationId, getRequestId } from '../src/utils/requestContext';
import { scanDirectoryForSecrets } from '../scripts/security-scan';
import { resolve } from 'path';

describe('P4 Issue 20: Universal Structured Logging & Sensitive Redaction', () => {
  it('Deep redaction masks passwords, tokens, OTPs, auth headers, and secrets in objects and nested arrays', () => {
    const payload = {
      password: 'MySecretPassword99!',
      otp: '654321',
      token: 'jwt-access-token',
      access_token: 'access_secret_token',
      refresh_token: 'refresh_secret_token',
      fcm_token: 'fcm-device-push-token',
      devicetoken: 'device-token-123',
      razorpay_key_secret: 'rzp_sec_secret',
      webhook_secret: 'whsec_secret',
      authorization: 'Bearer secret-bearer-token',
      nested: {
        userPassword: 'nestedPassword123',
        privateKey: 'private-key-data',
        safeProperty: 'VisibleData',
      },
      arrayItems: [
        { otp: '112233', safeKey: 'item1' },
        { token: 'secret-tok', safeKey: 'item2' },
      ],
    };

    const sanitized = redactSensitiveData(payload);

    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.otp).toBe('[REDACTED]');
    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.access_token).toBe('[REDACTED]');
    expect(sanitized.refresh_token).toBe('[REDACTED]');
    expect(sanitized.fcm_token).toBe('[REDACTED]');
    expect(sanitized.devicetoken).toBe('[REDACTED]');
    expect(sanitized.razorpay_key_secret).toBe('[REDACTED]');
    expect(sanitized.webhook_secret).toBe('[REDACTED]');
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect(sanitized.nested.userPassword).toBe('[REDACTED]');
    expect(sanitized.nested.privateKey).toBe('[REDACTED]');
    expect(sanitized.nested.safeProperty).toBe('VisibleData');
    expect(sanitized.arrayItems[0].otp).toBe('[REDACTED]');
    expect(sanitized.arrayItems[1].token).toBe('[REDACTED]');
  });

  it('Bearer tokens inside arbitrary string messages are automatically masked', () => {
    const logString = 'Failed to execute provider call with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token to Razorpay';
    const sanitized = redactSensitiveData(logString);

    expect(sanitized).toBe('Failed to execute provider call with Bearer [REDACTED] to Razorpay');
  });

  it('Correlation ID and Request ID propagate via async request context across async operations', (done) => {
    const testReqId = 'req-test-uuid-1234';
    const testCorrId = 'corr-test-uuid-5678';

    runWithRequestContext({ requestId: testReqId, correlationId: testCorrId }, () => {
      expect(getRequestId()).toBe(testReqId);
      expect(getCorrelationId()).toBe(testCorrId);

      // Verify propagation in child logger
      const child = logger.child({ customKey: 'childValue' });
      expect(child).toBeDefined();

      setTimeout(() => {
        expect(getRequestId()).toBe(testReqId);
        expect(getCorrelationId()).toBe(testCorrId);
        done();
      }, 20);
    });
  });

  it('Zero direct console.* calls exist in production src/ directory', () => {
    const rootDir = resolve(__dirname, '..');
    const findings = scanDirectoryForSecrets(rootDir);

    const consoleFindings = findings.filter((f: any) =>
      f.patternName.includes('console.*')
    );

    expect(consoleFindings).toHaveLength(0);
  });
});
