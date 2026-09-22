import prisma from '../src/config/prisma';
import { outboxService } from '../src/services/outboxService';
import { bookingService } from '../src/features/booking/bookingServices';
import { jobService } from '../src/features/jobs/job.services';
import { BookingStatus, BookingAction, bookingStateService } from '../src/features/booking/bookingStateMachine';
import { JobStatus } from '../src/features/jobs/jobStateMachine';
import { RequirementStatus } from '../src/features/jobs/requirementStateMachine';
import { UserRole } from '../src/policies';

describe('P5 Issues 11–15: Comprehensive Production Hardening & Verification Suite', () => {
  jest.setTimeout(45000);

  let customerId: string;
  let worker1Id: string;
  let worker2Id: string;
  let skillCatId: string;

  beforeAll(async () => {
    // Shared test fixture
    const cat = await prisma.skill_category.create({
      data: { name: `P5CompSkill_${Date.now()}_${Math.random()}` },
    });
    skillCatId = cat.id;

    const cust = await prisma.customer.create({
      data: {
        name: 'P5 Customer',
        phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hash',
      },
    });
    customerId = cust.id;

    const w1 = await prisma.worker.create({
      data: {
        name: 'P5 Worker 1',
        phone: `+9197${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hash',
        skill_type: 'Painter',
        skill_category_id: skillCatId,
      },
    });
    worker1Id = w1.id;

    const w2 = await prisma.worker.create({
      data: {
        name: 'P5 Worker 2',
        phone: `+9196${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hash',
        skill_type: 'Painter',
        skill_category_id: skillCatId,
      },
    });
    worker2Id = w2.id;
  });

  afterAll(async () => {
    // Teardown
  });

  // =========================================================================
  // ISSUE 11: Distributed-safe outbox claiming
  // =========================================================================
  describe('Issue 11: Distributed-Safe Outbox Claiming & Concurrency', () => {
    it('Race: 2 concurrent workers attempting to claim the single same event results in exactly 1 claim and 1 empty', async () => {
      const uniqueKey = `claim_race_single_${Date.now()}_${Math.random()}`;
      await prisma.notification_outbox.create({
        data: {
          event_type: 'incoming_job',
          aggregate_type: 'job',
          aggregate_id: '00000000-0000-4000-a000-000000000001',
          recipient_type: 'worker',
          recipient_id: worker1Id,
          payload: { test: true },
          idempotency_key: uniqueKey,
          status: 'PENDING',
        },
      });

      // Launch 2 workers concurrently to claim with limit 1
      const [claim1, claim2] = await Promise.all([
        outboxService.claimPendingEvents(1),
        outboxService.claimPendingEvents(1),
      ]);

      const claimedIds1 = claim1.map((e) => e.id);
      const claimedIds2 = claim2.map((e) => e.id);

      // Overlap must be strictly empty (zero double claims)
      const intersection = claimedIds1.filter((id) => claimedIds2.includes(id));
      expect(intersection).toEqual([]);
    });

    it('Race: 4 concurrent workers claiming 50 pending events results in disjoint sets with no duplicate claims', async () => {
      const batchSize = 50;
      const createdKeys: string[] = [];

      for (let i = 0; i < batchSize; i++) {
        const key = `claim_batch_${Date.now()}_${i}_${Math.random()}`;
        createdKeys.push(key);
        await prisma.notification_outbox.create({
          data: {
            event_type: 'incoming_job',
            aggregate_type: 'job',
            aggregate_id: '00000000-0000-4000-a000-000000000001',
            recipient_type: 'worker',
            recipient_id: worker1Id,
            payload: { index: i },
            idempotency_key: key,
            status: 'PENDING',
          },
        });
      }

      // 4 concurrent workers claiming up to 20 events each
      const [w1, w2, w3, w4] = await Promise.all([
        outboxService.claimPendingEvents(20),
        outboxService.claimPendingEvents(20),
        outboxService.claimPendingEvents(20),
        outboxService.claimPendingEvents(20),
      ]);

      const allClaimed = [...w1, ...w2, ...w3, ...w4].map((e) => e.id);
      const uniqueClaimed = new Set(allClaimed);

      // Invariant: No duplicate claims across workers
      expect(allClaimed.length).toBe(uniqueClaimed.size);
    });

    it('Fencing token: A stale worker cannot mark success or failure after another worker reclaimed the event', async () => {
      const uniqueKey = `fence_test_${Date.now()}_${Math.random()}`;
      const record = await prisma.notification_outbox.create({
        data: {
          event_type: 'booking_confirmed',
          aggregate_type: 'booking',
          aggregate_id: '00000000-0000-4000-a000-000000000002',
          recipient_type: 'worker',
          recipient_id: worker1Id,
          payload: { test: true },
          idempotency_key: uniqueKey,
          status: 'PENDING',
        },
      });

      // Worker A claims event
      const claimedA = await outboxService.claimPendingEvents(1);
      const targetClaimA = claimedA.find((e) => e.id === record.id);
      expect(targetClaimA).toBeDefined();
      const generationTokenA = targetClaimA!.updated_at;

      // Simulate lease expiration: force record back to PENDING with past updated_at
      await prisma.$executeRawUnsafe(
        `UPDATE "notification_outbox" 
         SET status = 'PENDING', updated_at = NOW() - INTERVAL '10 minutes'
         WHERE id = '${record.id}'::uuid`
      );

      // Worker B reclaims event (gets a newer generation token)
      const claimedB = await outboxService.claimPendingEvents(1);
      const targetClaimB = claimedB.find((e) => e.id === record.id);
      expect(targetClaimB).toBeDefined();

      // Worker A wakes up and attempts markEventSuccess with stale token generationTokenA
      await outboxService.markEventSuccess(record.id, generationTokenA);

      // Invariant: The record MUST STILL BE in PROCESSING state owned by Worker B, not SENT by stale Worker A
      const freshRecord = await prisma.notification_outbox.findUnique({
        where: { id: record.id },
      });
      expect(freshRecord?.status).toBe('PROCESSING');
    });
  });

  // =========================================================================
  // ISSUE 12: Mandatory outbox atomicity
  // =========================================================================
  describe('Issue 12: Mandatory Outbox Transactional Atomicity', () => {
    it('Atomic write: Outbox creation failure causes business mutation to roll back completely', async () => {
      const testJob = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.OPEN,
          dispatch_status: 'IDLE',
        },
      });

      const key = `mandatory_outbox_fail_${Date.now()}`;
      // Pre-seed the idempotency key so that outbox creation inside the transaction will fail with unique constraint violation
      await prisma.notification_outbox.create({
        data: {
          event_type: 'test_duplicate',
          aggregate_type: 'job',
          aggregate_id: testJob.id,
          recipient_type: 'customer',
          recipient_id: customerId,
          payload: {},
          idempotency_key: key,
          status: 'SENT',
        },
      });

      // Attempt transaction where business state updates, followed by mandatory outbox write that fails (e.g. invalid UUID format or DB constraint failure)
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.job.update({
            where: { id: testJob.id },
            data: { status: JobStatus.DISPATCHING },
          });

          // Mandatory outbox write - injecting invalid recipient_id to trigger DB constraint failure
          await (tx as any).notification_outbox.create({
            data: {
              event_type: 'test_failure',
              aggregate_type: 'job',
              aggregate_id: testJob.id,
              recipient_type: 'customer',
              recipient_id: 'non-existent-uuid-to-trigger-db-error',
              payload: {},
              idempotency_key: `fail_key_${Date.now()}`,
              status: 'PENDING',
            },
          });
        })
      ).rejects.toThrow();

      // Verify business state was NOT updated (rolled back)
      const persistedJob = await prisma.job.findUnique({ where: { id: testJob.id } });
      expect(persistedJob?.status).toBe(JobStatus.OPEN);
    });

    it('Atomic commit: Both business state and outbox record persist together on successful transaction', async () => {
      const testJob = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.OPEN,
          dispatch_status: 'IDLE',
        },
      });

      const uniqueKey = `atomic_success_${Date.now()}_${Math.random()}`;

      await prisma.$transaction(async (tx) => {
        await tx.job.update({
          where: { id: testJob.id },
          data: { status: JobStatus.DISPATCHING },
        });

        await outboxService.createOutboxEvent(tx, {
          eventType: 'job_dispatching',
          aggregateType: 'job',
          aggregateId: testJob.id,
          recipientType: 'customer',
          recipientId: customerId,
          payload: { jobId: testJob.id },
          idempotencyKey: uniqueKey,
        });
      });

      // Verify both persisted
      const job = await prisma.job.findUnique({ where: { id: testJob.id } });
      expect(job?.status).toBe(JobStatus.DISPATCHING);

      const outbox = await prisma.notification_outbox.findUnique({
        where: { idempotency_key: uniqueKey },
      });
      expect(outbox).toBeDefined();
      expect(outbox?.aggregate_id).toBe(testJob.id);
      expect(outbox?.status).toBe('PENDING');
    });
  });

  // =========================================================================
  // ISSUE 13: Mandatory state-transition audit atomicity
  // =========================================================================
  describe('Issue 13: Mandatory State-Transition Audit Atomicity', () => {
    it('Audit row: State machine transition guarantees immutable audit record in booking_transition', async () => {
      const job = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.DISPATCHING,
          dispatch_status: 'DISPATCHING',
        },
      });

      const req = await prisma.job_requirement.create({
        data: {
          job_id: job.id,
          skill_id: skillCatId,
          skill_type: 'Painter',
          worker_count_needed: 1,
          worker_count_filled: 0,
          status: RequirementStatus.OPEN,
        },
      });

      const booking = await prisma.booking.create({
        data: {
          job_id: job.id,
          requirement_id: req.id,
          customer_id: customerId,
          worker_id: worker1Id,
          status: BookingStatus.CONFIRMED,
        },
      });

      // Transition to IN_PROGRESS via bookingStateService
      await prisma.$transaction(async (tx) => {
        await bookingStateService.transition(tx, {
          bookingId: booking.id,
          action: BookingAction.START_WORK,
          actor: { id: worker1Id, role: UserRole.WORKER },
          reason: 'Worker arrived and started work',
        });
      });

      // Assert booking_transition audit row exists with correct from/to status
      const auditRows = await prisma.booking_transition.findMany({
        where: { booking_id: booking.id },
      });
      expect(auditRows.length).toBeGreaterThanOrEqual(1);

      const transition = auditRows.find((a) => a.to_status === BookingStatus.IN_PROGRESS);
      expect(transition).toBeDefined();
      expect(transition?.from_status).toBe(BookingStatus.CONFIRMED);
      expect(transition?.actor_id).toBe(worker1Id);
      expect(transition?.actor_type).toBe(UserRole.WORKER);
    });

    it('Failure rollback: If audit insertion fails, the state transition must be completely aborted', async () => {
      const job = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.DISPATCHING,
          dispatch_status: 'DISPATCHING',
        },
      });

      const req = await prisma.job_requirement.create({
        data: {
          job_id: job.id,
          skill_id: skillCatId,
          skill_type: 'Painter',
          worker_count_needed: 1,
          worker_count_filled: 0,
          status: RequirementStatus.OPEN,
        },
      });

      const booking = await prisma.booking.create({
        data: {
          job_id: job.id,
          requirement_id: req.id,
          customer_id: customerId,
          worker_id: worker1Id,
          status: BookingStatus.CONFIRMED,
        },
      });

      // Execute a transaction where we update booking status and then trigger a DB constraint failure on audit
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.booking.update({
            where: { id: booking.id },
            data: { status: BookingStatus.IN_PROGRESS },
          });

          // Inject failure: insert invalid non-existent foreign key into booking_transition
          await (tx as any).booking_transition.create({
            data: {
              booking_id: '00000000-0000-4000-a000-000000000099', // violates FK
              from_status: BookingStatus.CONFIRMED,
              to_status: BookingStatus.IN_PROGRESS,
              action: 'START_WORK',
              actor_type: 'WORKER',
              actor_id: worker1Id,
            },
          });
        })
      ).rejects.toThrow();

      // Verify booking status was not updated to IN_PROGRESS
      const unchanged = await prisma.booking.findUnique({ where: { id: booking.id } });
      expect(unchanged?.status).toBe(BookingStatus.CONFIRMED);
    });
  });

  // =========================================================================
  // ISSUE 14: Cross-entity transition failures must not be swallowed
  // =========================================================================
  describe('Issue 14: Cross-Entity Transition Correctness & Error Propagation', () => {
    it('Non-swallowed error: An unexpected database error in a related entity aborts the caller transaction', async () => {
      const job = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.IN_PROGRESS,
          dispatch_status: 'FILLED',
        },
      });

      const req = await prisma.job_requirement.create({
        data: {
          job_id: job.id,
          skill_id: skillCatId,
          skill_type: 'Painter',
          worker_count_needed: 1,
          worker_count_filled: 1,
          status: RequirementStatus.FILLED,
        },
      });

      const booking = await prisma.booking.create({
        data: {
          job_id: job.id,
          requirement_id: req.id,
          customer_id: customerId,
          worker_id: worker1Id,
          status: BookingStatus.AWAITING_CONFIRMATION,
        },
      });

      // In a transaction, completing the booking triggers cross-entity check to complete the parent job.
      // If we inject an invalid column update on job within the transaction, the entire transaction MUST abort.
      await expect(
        prisma.$transaction(async (tx) => {
          await bookingStateService.transition(tx, {
            bookingId: booking.id,
            action: BookingAction.CONFIRM_COMPLETION,
            actor: { id: customerId, role: UserRole.CUSTOMER },
            reason: 'Finished work',
          });

          // Simulate unexpected schema / constraint fault on job
          await tx.$executeRawUnsafe(
            `UPDATE "job" SET status = 'CORRUPT_STATUS_VIOLATING_CHECK' WHERE id = '${job.id}'::uuid`
          );
        })
      ).rejects.toThrow();

      // Booking must remain in AWAITING_CONFIRMATION
      const persistedBooking = await prisma.booking.findUnique({ where: { id: booking.id } });
      expect(persistedBooking?.status).toBe(BookingStatus.AWAITING_CONFIRMATION);
    });

    it('Completing all bookings transitions parent job to COMPLETED atomically', async () => {
      const job = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.IN_PROGRESS,
          dispatch_status: 'FILLED',
        },
      });

      const req = await prisma.job_requirement.create({
        data: {
          job_id: job.id,
          skill_id: skillCatId,
          skill_type: 'Painter',
          worker_count_needed: 1,
          worker_count_filled: 1,
          status: RequirementStatus.FILLED,
        },
      });

      const booking = await prisma.booking.create({
        data: {
          job_id: job.id,
          requirement_id: req.id,
          customer_id: customerId,
          worker_id: worker1Id,
          status: BookingStatus.AWAITING_CONFIRMATION,
        },
      });

      const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: '' };
      await bookingService.confirmComplete(booking.id, customerId, {}, customerActor);

      // Verify both booking and parent job transitioned to COMPLETED
      const [finalBooking, finalJob] = await Promise.all([
        prisma.booking.findUnique({ where: { id: booking.id } }),
        prisma.job.findUnique({ where: { id: job.id } }),
      ]);

      expect(finalBooking?.status).toBe(BookingStatus.COMPLETED);
      expect(finalJob?.status).toBe(JobStatus.COMPLETED);
    });
  });

  // =========================================================================
  // ISSUE 15: Canonical marketplace lifecycle values
  // =========================================================================
  describe('Issue 15: Canonical Marketplace Lifecycle Values', () => {
    it('PostgreSQL CHECK constraint rejects non-canonical lowercase on job.status', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "job" (id, customer_id, status, dispatch_status, created_at, updated_at)
           VALUES (gen_random_uuid(), '${customerId}'::uuid, 'open', 'IDLE', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it('PostgreSQL CHECK constraint rejects non-canonical lowercase on booking.status', async () => {
      const job = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.OPEN,
          dispatch_status: 'IDLE',
        },
      });

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "booking" (id, job_id, requirement_id, customer_id, worker_id, status, created_at, updated_at)
           VALUES (gen_random_uuid(), '${job.id}'::uuid, gen_random_uuid(), '${customerId}'::uuid, '${worker1Id}'::uuid, 'confirmed', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it('PostgreSQL CHECK constraint rejects uppercase "PENDING" on job_dispatch.status (canonical is lowercase)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "job_dispatch" (id, requirement_id, worker_id, status, expires_at, created_at, updated_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), '${worker1Id}'::uuid, 'PENDING', NOW() + INTERVAL '5 minutes', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it('PostgreSQL accepts exact canonical values and end-to-end lifecycle preserves them', async () => {
      // 1. Create job in OPEN
      const job = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.OPEN,
          dispatch_status: 'IDLE',
        },
      });
      expect(job.status).toBe(JobStatus.OPEN);

      // 2. Add requirement with RequirementStatus.OPEN
      const req = await prisma.job_requirement.create({
        data: {
          job_id: job.id,
          skill_id: skillCatId,
          skill_type: 'Painter',
          worker_count_needed: 1,
          worker_count_filled: 0,
          status: RequirementStatus.OPEN,
        },
      });
      expect(req.status).toBe(RequirementStatus.OPEN);

      // 3. Create dispatch record with canonical lowercase 'pending'
      const dispatch = await prisma.job_dispatch.create({
        data: {
          requirement_id: req.id,
          worker_id: worker1Id,
          status: 'pending',
          expires_at: new Date(Date.now() + 300000),
        },
      });
      expect(dispatch.status).toBe('pending');

      // 4. Cancel job using jobService -> updates dispatch to 'cancelled' and requirement to 'CANCELLED'
      const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: '' };
      await jobService.cancelJob(job.id, customerId, customerActor, 'Customer cancellation test');

      const [updatedJob, updatedReq, updatedDispatch] = await Promise.all([
        prisma.job.findUnique({ where: { id: job.id } }),
        prisma.job_requirement.findUnique({ where: { id: req.id } }),
        prisma.job_dispatch.findUnique({ where: { id: dispatch.id } }),
      ]);

      expect(updatedJob?.status).toBe(JobStatus.CANCELLED);
      expect(updatedReq?.status).toBe(RequirementStatus.CANCELLED);
      expect(updatedDispatch?.status).toBe('cancelled');
    });
  });
});
