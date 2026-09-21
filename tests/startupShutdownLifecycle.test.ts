import {
  getLifecycleState,
  isReady,
  isShuttingDown,
  setLifecycleState,
  startApplication,
  gracefulShutdown,
  reconcileStartupState
} from '../src/lifecycle/lifecycleManager';
import prisma from '../src/config/prisma';
import { Server } from 'http';

describe('Issue 38 - Complete Startup Recovery & Graceful Shutdown', () => {
  beforeEach(() => {
    setLifecycleState('INITIALIZING');
  });

  afterAll(async () => {
    setLifecycleState('READY');
  });

  describe('Lifecycle State Transitions', () => {
    it('initializes in INITIALIZING state', () => {
      expect(getLifecycleState()).toBe('INITIALIZING');
      expect(isReady()).toBe(false);
      expect(isShuttingDown()).toBe(false);
    });

    it('transitions to READY and returns true for isReady', () => {
      setLifecycleState('READY');
      expect(getLifecycleState()).toBe('READY');
      expect(isReady()).toBe(true);
      expect(isShuttingDown()).toBe(false);
    });

    it('transitions to SHUTTING_DOWN and returns true for isShuttingDown', () => {
      setLifecycleState('SHUTTING_DOWN');
      expect(getLifecycleState()).toBe('SHUTTING_DOWN');
      expect(isReady()).toBe(false);
      expect(isShuttingDown()).toBe(true);
    });
  });

  describe('Startup Reconciliation', () => {
    it('executes idempotently without errors', async () => {
      await expect(reconcileStartupState()).resolves.not.toThrow();
      // Running a second time should also be completely safe and idempotent
      await expect(reconcileStartupState()).resolves.not.toThrow();
    });
  });

  describe('Graceful Shutdown Flow', () => {
    it('executes all phases of graceful shutdown idempotently', async () => {
      const mockServer = {
        close: jest.fn((cb) => (cb ? cb() : undefined))
      } as unknown as Server;

      const shutdownPromise = gracefulShutdown(mockServer, 'TEST_SIGNAL');
      await expect(shutdownPromise).resolves.not.toThrow();
      expect(getLifecycleState()).toBe('TERMINATED');

      // Second call should return immediately without re-closing
      await expect(gracefulShutdown(mockServer, 'TEST_SIGNAL')).resolves.not.toThrow();
    });
  });
});
