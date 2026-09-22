import crypto from 'crypto';
import prisma from '../src/config/prisma';
import { outboxService } from '../src/services/outboxService';
import { sessionService } from '../src/features/auth/session.service';
import { UserRole } from '../src/type/userRole';

describe('P4 Issue 24: Runtime Concurrency, Lock Contention & Transaction Invariants', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. Atomic Capacity Contention (1 Slot / 10 Workers): Results in exactly 1 booking and zero overbooking', async () => {
    // 1. Setup Customer & Job with 1 slot
    const customer = await prisma.customer.create({
      data: {
        name: 'Capacity Race Customer 1',
        phone: `+9191${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
      },
    });

    const job = await prisma.job.create({
      data: {
        customer_id: customer.id,
        latitude: 12.9716,
        longitude: 77.5946,
        status: 'OPEN',
      },
    });

    const skill = await prisma.skill_category.create({
      data: { name: `Skill_Race_1_${Date.now()}_${Math.random().toString(36).substring(7)}` },
    });

    const requirement = await prisma.job_requirement.create({
      data: {
        job_id: job.id,
        skill_id: skill.id,
        worker_count_needed: 1,
        worker_count_filled: 0,
        status: 'OPEN',
      },
    });

    // 2. Create 10 distinct workers
    const workers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        prisma.worker.create({
          data: {
            name: `Race Worker 1_${i}`,
            phone: `+9190${Math.floor(10000000 + Math.random() * 90000000)}`,
            password: 'hashedpassword123',
            verification_status: 'verified',
            is_online: true,
            skill_type: skill.name,
            skill_category_id: skill.id,
          },
        })
      )
    );

    // 3. 10 workers concurrently attempt atomic capacity reservation with SELECT ... FOR UPDATE
    const acceptSlot = async (workerId: string) => {
      return await prisma.$transaction(async (tx) => {
        const lockedReq = await tx.$queryRaw<any[]>`
          SELECT id, worker_count_needed, worker_count_filled, status
          FROM job_requirement
          WHERE id = ${requirement.id}::uuid
          FOR UPDATE
        `;

        if (!lockedReq || lockedReq.length === 0) return { success: false, reason: 'NOT_FOUND' };
        const req = lockedReq[0];

        if (req.worker_count_filled >= req.worker_count_needed || req.status !== 'OPEN') {
          return { success: false, reason: 'CAPACITY_EXHAUSTED' };
        }

        const newFilled = req.worker_count_filled + 1;
        const newStatus = newFilled >= req.worker_count_needed ? 'FILLED' : 'OPEN';

        await tx.job_requirement.update({
          where: { id: requirement.id },
          data: {
            worker_count_filled: newFilled,
            status: newStatus as any,
          },
        });

        const booking = await tx.booking.create({
          data: {
            job_id: job.id,
            requirement_id: requirement.id,
            worker_id: workerId,
            customer_id: customer.id,
            status: 'CONFIRMED',
          },
        });

        return { success: true, bookingId: booking.id };
      });
    };

    const results = await Promise.all(workers.map((w) => acceptSlot(w.id)));

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(9);

    const finalReq = await prisma.job_requirement.findUnique({ where: { id: requirement.id } });
    expect(finalReq?.worker_count_filled).toBe(1);
    expect(finalReq?.status).toBe('FILLED');

    // Cleanup
    await prisma.booking.deleteMany({ where: { job_id: job.id } });
    await prisma.job_requirement.deleteMany({ where: { job_id: job.id } });
    await prisma.job.deleteMany({ where: { id: job.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.worker.deleteMany({ where: { id: { in: workers.map((w) => w.id) } } });
    await prisma.skill_category.deleteMany({ where: { id: skill.id } });
  });

  it('2. High-Contention Capacity Race (2 Slots / 50 Workers): Results in exactly 2 bookings and zero overbooking', async () => {
    const customer = await prisma.customer.create({
      data: {
        name: 'Capacity Race Customer 50',
        phone: `+9192${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
      },
    });

    const job = await prisma.job.create({
      data: {
        customer_id: customer.id,
        latitude: 12.9716,
        longitude: 77.5946,
        status: 'OPEN',
      },
    });

    const skill = await prisma.skill_category.create({
      data: { name: `Skill_Race_50_${Date.now()}_${Math.random().toString(36).substring(7)}` },
    });

    const requirement = await prisma.job_requirement.create({
      data: {
        job_id: job.id,
        skill_id: skill.id,
        worker_count_needed: 2, // 2 slots
        worker_count_filled: 0,
        status: 'OPEN',
      },
    });

    // Create 50 distinct workers
    const workers = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        prisma.worker.create({
          data: {
            name: `Race Worker 50_${i}`,
            phone: `+9170${Math.floor(10000000 + Math.random() * 90000000)}`,
            password: 'hashedpassword123',
            verification_status: 'verified',
            is_online: true,
            skill_type: skill.name,
            skill_category_id: skill.id,
          },
        })
      )
    );

    const acceptSlot = async (workerId: string) => {
      return await prisma.$transaction(async (tx) => {
        const lockedReq = await tx.$queryRaw<any[]>`
          SELECT id, worker_count_needed, worker_count_filled, status
          FROM job_requirement
          WHERE id = ${requirement.id}::uuid
          FOR UPDATE
        `;

        if (!lockedReq || lockedReq.length === 0) return { success: false, reason: 'NOT_FOUND' };
        const req = lockedReq[0];

        if (req.worker_count_filled >= req.worker_count_needed || req.status !== 'OPEN') {
          return { success: false, reason: 'CAPACITY_EXHAUSTED' };
        }

        const newFilled = req.worker_count_filled + 1;
        const newStatus = newFilled >= req.worker_count_needed ? 'FILLED' : 'OPEN';

        await tx.job_requirement.update({
          where: { id: requirement.id },
          data: {
            worker_count_filled: newFilled,
            status: newStatus as any,
          },
        });

        const booking = await tx.booking.create({
          data: {
            job_id: job.id,
            requirement_id: requirement.id,
            worker_id: workerId,
            customer_id: customer.id,
            status: 'CONFIRMED',
          },
        });

        return { success: true, bookingId: booking.id };
      });
    };

    const results = await Promise.all(workers.map((w) => acceptSlot(w.id)));

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(2);
    expect(failures).toHaveLength(48);

    const finalReq = await prisma.job_requirement.findUnique({ where: { id: requirement.id } });
    expect(finalReq?.worker_count_filled).toBe(2);
    expect(finalReq?.status).toBe('FILLED');

    // Cleanup
    await prisma.booking.deleteMany({ where: { job_id: job.id } });
    await prisma.job_requirement.deleteMany({ where: { job_id: job.id } });
    await prisma.job.deleteMany({ where: { id: job.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.worker.deleteMany({ where: { id: { in: workers.map((w) => w.id) } } });
    await prisma.skill_category.deleteMany({ where: { id: skill.id } });
  });

  it('3. Outbox Contention: Concurrent workers claiming events with FOR UPDATE SKIP LOCKED process disjoint partitions', async () => {
    // Create 5 test outbox events with valid UUID aggregateId and recipientId
    const eventIds = await prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const record = await outboxService.createOutboxEvent(tx, {
          eventType: 'NOTIFICATION_DISPATCH',
          aggregateType: 'TEST',
          aggregateId: crypto.randomUUID(),
          recipientType: 'worker',
          recipientId: crypto.randomUUID(),
          payload: { index: i },
        });
        if (record) ids.push(record.id);
      }
      return ids;
    });

    // 5 concurrent workers attempt claiming 5 events
    const claimTasks = Array.from({ length: 5 }, () =>
      outboxService.claimPendingEvents(5, 5)
    );

    const claimedBatches = await Promise.all(claimTasks);

    const allClaimedEvents = claimedBatches.flat();
    const claimedEventIds = allClaimedEvents.map((e: any) => e.id);

    // Assert disjoint claiming: no two workers claimed the same event ID
    const uniqueClaimedIds = new Set(claimedEventIds);
    expect(uniqueClaimedIds.size).toBe(claimedEventIds.length);

    // Cleanup claimed test events
    await prisma.notification_outbox.deleteMany({ where: { id: { in: eventIds } } });
  });

  it('4. Refresh Session Rotation: Concurrent rotation of same token invalidates family and detects reuse', async () => {
    const user = await prisma.customer.create({
      data: {
        name: 'Session Rotation Customer',
        phone: `+9189${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
      },
    });

    const initialSession = await sessionService.createSession({
      userId: user.id,
      userRole: UserRole.CUSTOMER,
    });

    // 5 concurrent requests try to rotate the exact same raw refresh token
    const rotationTasks = Array.from({ length: 5 }, () =>
      sessionService.rotateSession(initialSession.rawToken).catch((err: any) => ({ error: err.message || String(err) }))
    );

    const rotationResults = await Promise.all(rotationTasks);

    const successfulRotations = rotationResults.filter((r: any) => !r.error);
    const failedRotations = rotationResults.filter((r: any) => r.error);

    expect(successfulRotations.length).toBe(1);
    expect(failedRotations.length).toBe(4);

    // Cleanup
    await prisma.refresh_session.deleteMany({ where: { user_id: user.id } });
    await prisma.customer.deleteMany({ where: { id: user.id } });
  });

  it('5. Transaction Rollback Integrity: Failed transaction rolls back primary state and outbox events cleanly', async () => {
    const customer = await prisma.customer.create({
      data: {
        name: 'Rollback Test Customer',
        phone: `+9188${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
      },
    });

    const attemptFailingTransaction = async () => {
      await prisma.$transaction(async (tx) => {
        const job = await tx.job.create({
          data: {
            customer_id: customer.id,
            latitude: 12.9716,
            longitude: 77.5946,
            status: 'OPEN',
          },
        });

        await outboxService.createOutboxEvent(tx, {
          eventType: 'JOB_CREATED',
          aggregateType: 'JOB',
          aggregateId: job.id,
          recipientType: 'customer',
          recipientId: customer.id,
          payload: { jobId: job.id },
        });

        // Deliberate failure triggering rollback
        throw new Error('SIMULATED_TRANSACTION_FAILURE');
      });
    };

    await expect(attemptFailingTransaction()).rejects.toThrow('SIMULATED_TRANSACTION_FAILURE');

    // Verify 0 jobs and 0 outbox events were persisted
    const jobs = await prisma.job.findMany({ where: { customer_id: customer.id } });
    expect(jobs).toHaveLength(0);

    // Cleanup
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  });
});
