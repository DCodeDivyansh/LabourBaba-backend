import { Client } from 'pg';
import prisma from '../src/config/prisma';
import { sessionService } from '../src/features/auth/session.service';
import { acceptDispatch } from '../src/features/dispatch/dispatchServices';
import { outboxService } from '../src/services/outboxService';
import { UserRole } from '../src/type/userRole';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

async function runAdversarialRaces() {
  console.log('====================================================');
  console.log('ADVERSARIAL CONCURRENCY DRILL: LIVE POSTGRESQL & REDIS');
  console.log('====================================================\n');

  // Ensure Skill Category exists
  let cat = await prisma.skill_category.findFirst();
  if (!cat) {
    cat = await prisma.skill_category.create({
      data: { name: 'AdversarialDrillSkill', description: 'Drill Skill' }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 12. REFRESH TOKEN RACE (10, 50, 100 simultaneous requests)
  // ─────────────────────────────────────────────────────────────
  console.log('>>> [DRILL 12] REFRESH TOKEN RACE: 10, 50, 100 Simultaneous Requests on 1 Token');
  for (const count of [10, 50, 100]) {
    const testUserId = randomUUID();
    await prisma.customer.create({
      data: {
        id: testUserId,
        phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
        name: `RefreshUser_${count}`,
        password: 'hash'
      }
    });

    const session = await sessionService.createSession({
      userId: testUserId,
      userRole: UserRole.CUSTOMER
    });

    const results = await Promise.allSettled(
      Array.from({ length: count }, () => sessionService.rotateSession(session.rawToken))
    );

    let fulfilledCount = 0;
    let conflictCount = 0;
    let otherErrorCount = 0;
    const errorCodes: Record<string, number> = {};

    for (const r of results) {
      if (r.status === 'fulfilled') {
        fulfilledCount++;
      } else {
        const errCode = (r.reason as any)?.code || (r.reason as any)?.message || 'UNKNOWN';
        errorCodes[errCode] = (errorCodes[errCode] || 0) + 1;
        if (errCode === 'CONCURRENT_REFRESH_CONFLICT') {
          conflictCount++;
        } else {
          otherErrorCount++;
        }
      }
    }

    // Inspect database state
    const allFamilySessions = await prisma.refresh_session.findMany({
      where: { family_id: session.familyId }
    });
    const activeSessions = allFamilySessions.filter(s => s.status === 'ACTIVE');

    console.log(`[REFRESH RACE ${count} REQUESTS]:`);
    console.log(`  Fulfilled (Winners): ${fulfilledCount}`);
    console.log(`  Conflicts (Losers caught by race gate): ${conflictCount}`);
    console.log(`  Other Errors: ${otherErrorCount}`, Object.keys(errorCodes).length > 0 ? errorCodes : '');
    console.log(`  Total Sessions in Family: ${allFamilySessions.length}`);
    console.log(`  Active Successors Remaining: ${activeSessions.length}`);
    console.log(`  INVARIANT: Exactly 1 winner & exactly 1 ACTIVE successor? ${fulfilledCount === 1 && activeSessions.length === 1 ? 'PROVEN' : 'VIOLATED'}\n`);
  }

  // ─────────────────────────────────────────────────────────────
  // 13. BOOKING CAPACITY RACE: capacity = 1 (10, 50, 100, 250)
  // ─────────────────────────────────────────────────────────────
  console.log('>>> [DRILL 13A] BOOKING CAPACITY RACE: Capacity = 1 (10, 50, 100, 250 Workers)');
  for (const workerCount of [10, 50, 100, 250]) {
    const custId = randomUUID();
    await prisma.customer.create({
      data: {
        id: custId,
        phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
        name: `Cap1_Cust_${workerCount}`,
        password: 'hash'
      }
    });

    const job = await prisma.job.create({
      data: { customer_id: custId, status: 'OPEN' }
    });

    const req = await prisma.job_requirement.create({
      data: {
        job_id: job.id,
        worker_count_needed: 1,
        worker_count_filled: 0,
        status: 'OPEN'
      }
    });

    // Seed N distinct verified workers and job_dispatch records
    const workerIds: string[] = [];
    for (let i = 0; i < workerCount; i++) {
      const wId = randomUUID();
      await prisma.worker.create({
        data: {
          id: wId,
          phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
          name: `DrillWorker_${workerCount}_${i}`,
          password: 'hash',
          skill_type: 'Helper',
          skill_category_id: cat.id,
          verification_status: 'verified'
        }
      });
      await prisma.job_dispatch.create({
        data: {
          requirement_id: req.id,
          worker_id: wId,
          status: 'pending',
          wave_number: 1
        }
      });
      workerIds.push(wId);
    }

    // Fire simultaneous accepts
    const startTime = Date.now();
    const acceptResults = await Promise.allSettled(
      workerIds.map(wId => acceptDispatch(req.id, wId))
    );
    const duration = Date.now() - startTime;

    let successCount = 0;
    let conflictCount = 0;
    let otherCount = 0;

    for (const res of acceptResults) {
      if (res.status === 'fulfilled') {
        successCount++;
      } else {
        const msg = String((res.reason as any)?.message || '');
        if (msg.includes('filled') || msg.includes('booked') || (res.reason as any)?.statusCode === 409 || (res.reason as any)?.code === 'REQUIREMENT_FILLED' || (res.reason as any)?.code === 'SLOT_UNAVAILABLE') {
          conflictCount++;
        } else {
          otherCount++;
        }
      }
    }

    const finalReq = await prisma.job_requirement.findUnique({ where: { id: req.id } });
    const finalBookings = await prisma.booking.findMany({ where: { requirement_id: req.id } });

    console.log(`[BOOKING RACE: Capacity=1, Workers=${workerCount}, Duration=${duration}ms]:`);
    console.log(`  Successful Accepts: ${successCount}`);
    console.log(`  Graceful Capacity Conflicts: ${conflictCount}`);
    console.log(`  Other Failures: ${otherCount}`);
    console.log(`  DB worker_count_filled: ${finalReq?.worker_count_filled}`);
    console.log(`  DB Bookings Count: ${finalBookings.length}`);
    console.log(`  INVARIANT: Bookings (${finalBookings.length}) <= Capacity (1)? ${finalBookings.length <= 1 && successCount === 1 ? 'PROVEN' : 'VIOLATED'}\n`);
  }

  // ─────────────────────────────────────────────────────────────
  // 13B. BOOKING CAPACITY RACE: capacity = 5 (50, 100, 250 Workers)
  // ─────────────────────────────────────────────────────────────
  console.log('>>> [DRILL 13B] BOOKING CAPACITY RACE: Capacity = 5 (50, 100, 250 Workers)');
  for (const workerCount of [50, 100, 250]) {
    const custId = randomUUID();
    await prisma.customer.create({
      data: {
        id: custId,
        phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
        name: `Cap5_Cust_${workerCount}`,
        password: 'hash'
      }
    });

    const job = await prisma.job.create({
      data: { customer_id: custId, status: 'OPEN' }
    });

    const req = await prisma.job_requirement.create({
      data: {
        job_id: job.id,
        worker_count_needed: 5,
        worker_count_filled: 0,
        status: 'OPEN'
      }
    });

    const workerIds: string[] = [];
    for (let i = 0; i < workerCount; i++) {
      const wId = randomUUID();
      await prisma.worker.create({
        data: {
          id: wId,
          phone: `+9197${Math.floor(10000000 + Math.random() * 90000000)}`,
          name: `DrillWorker5_${workerCount}_${i}`,
          password: 'hash',
          skill_type: 'Helper',
          skill_category_id: cat.id,
          verification_status: 'verified'
        }
      });
      await prisma.job_dispatch.create({
        data: {
          requirement_id: req.id,
          worker_id: wId,
          status: 'pending',
          wave_number: 1
        }
      });
      workerIds.push(wId);
    }

    const startTime = Date.now();
    const acceptResults = await Promise.allSettled(
      workerIds.map(wId => acceptDispatch(req.id, wId))
    );
    const duration = Date.now() - startTime;

    let successCount = 0;
    let conflictCount = 0;
    let otherCount = 0;

    for (const res of acceptResults) {
      if (res.status === 'fulfilled') {
        successCount++;
      } else {
        const msg = String((res.reason as any)?.message || '');
        if (msg.includes('filled') || msg.includes('booked') || (res.reason as any)?.statusCode === 409 || (res.reason as any)?.code === 'REQUIREMENT_FILLED' || (res.reason as any)?.code === 'SLOT_UNAVAILABLE') {
          conflictCount++;
        } else {
          otherCount++;
        }
      }
    }

    const finalReq = await prisma.job_requirement.findUnique({ where: { id: req.id } });
    const finalBookings = await prisma.booking.findMany({ where: { requirement_id: req.id } });

    console.log(`[BOOKING RACE: Capacity=5, Workers=${workerCount}, Duration=${duration}ms]:`);
    console.log(`  Successful Accepts: ${successCount}`);
    console.log(`  Conflicts: ${conflictCount}`);
    console.log(`  Other Failures: ${otherCount}`);
    console.log(`  DB worker_count_filled: ${finalReq?.worker_count_filled}`);
    console.log(`  DB Bookings Count: ${finalBookings.length}`);
    console.log(`  INVARIANT: Bookings (${finalBookings.length}) <= Capacity (5)? ${finalBookings.length <= 5 && successCount === 5 ? 'PROVEN' : 'VIOLATED'}\n`);
  }

  // ─────────────────────────────────────────────────────────────
  // 15. OUTBOX CONCURRENT CLAIMS RACE (Multi-Worker SKIP LOCKED)
  // ─────────────────────────────────────────────────────────────
  console.log('>>> [DRILL 15] OUTBOX CONCURRENT CLAIMS RACE (SKIP LOCKED)');
  const outboxId = randomUUID();
  await (prisma as any).notification_outbox.create({
    data: {
      id: outboxId,
      event_type: 'race_test_event',
      aggregate_type: 'job',
      aggregate_id: randomUUID(),
      recipient_type: 'worker',
      recipient_id: randomUUID(),
      payload: { test: true },
      status: 'PENDING',
      idempotency_key: `race_outbox_${Date.now()}`
    }
  });

  const claimPromises = Array.from({ length: 10 }, () => outboxService.claimPendingEvents(10));
  const claimedBatches = await Promise.all(claimPromises);

  let claimOwners = 0;
  for (const batch of claimedBatches) {
    if (batch.some((e: any) => e.id === outboxId)) {
      claimOwners++;
    }
  }

  console.log(`[OUTBOX RACE]: Claimed by ${claimOwners} worker instance(s) concurrently.`);
  console.log(`INVARIANT: Exactly 1 worker claimed the event? ${claimOwners === 1 ? 'PROVEN' : 'VIOLATED'}\n`);

  await prisma.$disconnect();
}

runAdversarialRaces().catch((e) => {
  console.error('Adversarial Races FAILED:', e);
  process.exit(1);
});
