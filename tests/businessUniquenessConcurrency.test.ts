import prisma from '../src/config/prisma';
import { Prisma } from '@prisma/client';

describe('Issue #32: Business Uniqueness & Concurrency Review', () => {
  let customerId: string;
  let workerId1: string;
  let workerId2: string;
  let skillCategoryId: string;
  let jobId: string;
  let requirementId: string;

  beforeAll(async () => {
    // 1. Create skill category
    const skill = await prisma.skill_category.create({
      data: {
        name: `Skill_Uniq_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      },
    });
    skillCategoryId = skill.id;

    // 2. Create customer
    const customer = await prisma.customer.create({
      data: {
        name: 'Uniqueness Test Customer',
        phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
      },
    });
    customerId = customer.id;

    // 3. Create workers
    const worker1 = await prisma.worker.create({
      data: {
        name: 'Worker Unique 1',
        phone: `+9197${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
        skill_category_id: skillCategoryId,
        skill_type: skill.name,
        verification_status: 'verified',
        is_online: true,
      },
    });
    workerId1 = worker1.id;

    const worker2 = await prisma.worker.create({
      data: {
        name: 'Worker Unique 2',
        phone: `+9196${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
        skill_category_id: skillCategoryId,
        skill_type: skill.name,
        verification_status: 'verified',
        is_online: true,
      },
    });
    workerId2 = worker2.id;

    // 4. Create job & requirement
    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        status: 'OPEN',
        dispatch_status: 'IDLE',
      },
    });
    jobId = job.id;

    const req = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_id: skillCategoryId,
        worker_count_needed: 2,
        worker_count_filled: 0,
        status: 'OPEN',
      },
    });
    requirementId = req.id;
  });

  afterAll(async () => {
    // Cleanup created test records
    try {
      if (requirementId) {
        await prisma.review.deleteMany({ where: { customer_id: customerId } });
        await prisma.payment.deleteMany({ where: { booking: { customer_id: customerId } } });
        await prisma.booking_transition.deleteMany({ where: { booking: { customer_id: customerId } } });
        await prisma.booking.deleteMany({ where: { customer_id: customerId } });
        await prisma.job_dispatch.deleteMany({ where: { requirement_id: requirementId } });
        await prisma.dispatch_wave.deleteMany({ where: { requirement_id: requirementId } });
        await prisma.job_requirement.deleteMany({ where: { id: requirementId } });
      }
      if (jobId) {
        await prisma.job_transition.deleteMany({ where: { job_id: jobId } });
        await prisma.job.deleteMany({ where: { id: jobId } });
      }
      if (workerId1) {
        await prisma.worker_device.deleteMany({ where: { worker_id: workerId1 } });
        await prisma.worker.deleteMany({ where: { id: workerId1 } });
      }
      if (workerId2) {
        await prisma.worker_device.deleteMany({ where: { worker_id: workerId2 } });
        await prisma.worker.deleteMany({ where: { id: workerId2 } });
      }
      if (customerId) {
        await prisma.customer.deleteMany({ where: { id: customerId } });
      }
      if (skillCategoryId) {
        await prisma.skill_category.deleteMany({ where: { id: skillCategoryId } });
      }
    } catch (e) {
      // Ignore teardown cleanup errors
    } finally {
      await prisma.$disconnect();
    }
  });

  // TEST 1 — Requirement + Dispatch Wave
  test('TEST 1: Requirement + Wave uniqueness rejects concurrent identical wave creation', async () => {
    const waveNumber = 1;
    const opId1 = `op_wave_${Date.now()}_1`;
    const opId2 = `op_wave_${Date.now()}_2`;

    const attempts = await Promise.allSettled([
      prisma.dispatch_wave.create({
        data: {
          requirement_id: requirementId,
          wave_number: waveNumber,
          operation_id: opId1,
          status: 'active',
        },
      }),
      prisma.dispatch_wave.create({
        data: {
          requirement_id: requirementId,
          wave_number: waveNumber,
          operation_id: opId2,
          status: 'active',
        },
      }),
    ]);

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const waves = await prisma.dispatch_wave.findMany({
      where: { requirement_id: requirementId, wave_number: waveNumber },
    });
    expect(waves.length).toBe(1);
  });

  // TEST 2 — Requirement + Worker (JobDispatch & Booking)
  test('TEST 2: Requirement + Worker uniqueness rejects duplicate dispatches and bookings', async () => {
    // A. Dispatch candidate association uniqueness
    const dispatchAttempts = await Promise.allSettled([
      prisma.job_dispatch.create({
        data: {
          requirement_id: requirementId,
          worker_id: workerId1,
          status: 'pending',
        },
      }),
      prisma.job_dispatch.create({
        data: {
          requirement_id: requirementId,
          worker_id: workerId1,
          status: 'pending',
        },
      }),
    ]);

    const dispatchFulfilled = dispatchAttempts.filter((a) => a.status === 'fulfilled');
    const dispatchRejected = dispatchAttempts.filter((a) => a.status === 'rejected');
    expect(dispatchFulfilled.length).toBe(1);
    expect(dispatchRejected.length).toBe(1);

    // B. Booking association uniqueness
    const bookingAttempts = await Promise.allSettled([
      prisma.booking.create({
        data: {
          job_id: jobId,
          requirement_id: requirementId,
          worker_id: workerId1,
          customer_id: customerId,
          status: 'CONFIRMED',
        },
      }),
      prisma.booking.create({
        data: {
          job_id: jobId,
          requirement_id: requirementId,
          worker_id: workerId1,
          customer_id: customerId,
          status: 'CONFIRMED',
        },
      }),
    ]);

    const bookingFulfilled = bookingAttempts.filter((a) => a.status === 'fulfilled');
    const bookingRejected = bookingAttempts.filter((a) => a.status === 'rejected');
    expect(bookingFulfilled.length).toBe(1);
    expect(bookingRejected.length).toBe(1);
  });

  // TEST 3 — Booking + Review
  test('TEST 3: Booking + Review uniqueness prevents duplicate reviews per booking', async () => {
    const existingBooking = await prisma.booking.findFirst({
      where: { requirement_id: requirementId, worker_id: workerId1 },
    });
    expect(existingBooking).not.toBeNull();

    const reviewAttempts = await Promise.allSettled([
      prisma.review.create({
        data: {
          booking_id: existingBooking!.id,
          worker_id: workerId1,
          customer_id: customerId,
          rating: 4.5,
          comment: 'Great work concurrent 1',
        },
      }),
      prisma.review.create({
        data: {
          booking_id: existingBooking!.id,
          worker_id: workerId1,
          customer_id: customerId,
          rating: 5.0,
          comment: 'Great work concurrent 2',
        },
      }),
    ]);

    const reviewFulfilled = reviewAttempts.filter((a) => a.status === 'fulfilled');
    const reviewRejected = reviewAttempts.filter((a) => a.status === 'rejected');
    expect(reviewFulfilled.length).toBe(1);
    expect(reviewRejected.length).toBe(1);

    const totalReviews = await prisma.review.count({
      where: { booking_id: existingBooking!.id },
    });
    expect(totalReviews).toBe(1);
  });

  // TEST 4 — Payment Identity
  test('TEST 4: Payment identity enforces exactly one payment order per booking', async () => {
    const existingBooking = await prisma.booking.findFirst({
      where: { requirement_id: requirementId, worker_id: workerId1 },
    });
    expect(existingBooking).not.toBeNull();

    const orderId1 = `order_test_${Date.now()}_1`;
    const orderId2 = `order_test_${Date.now()}_2`;

    const paymentAttempts = await Promise.allSettled([
      prisma.payment.create({
        data: {
          booking_id: existingBooking!.id,
          razorpay_order_id: orderId1,
          idempotency_key: existingBooking!.id,
          amount: 50000,
          currency: 'INR',
          status: 'created',
        },
      }),
      prisma.payment.create({
        data: {
          booking_id: existingBooking!.id,
          razorpay_order_id: orderId2,
          idempotency_key: existingBooking!.id,
          amount: 50000,
          currency: 'INR',
          status: 'created',
        },
      }),
    ]);

    const paymentFulfilled = paymentAttempts.filter((a) => a.status === 'fulfilled');
    const paymentRejected = paymentAttempts.filter((a) => a.status === 'rejected');
    expect(paymentFulfilled.length).toBe(1);
    expect(paymentRejected.length).toBe(1);

    const payments = await prisma.payment.findMany({
      where: { booking_id: existingBooking!.id },
    });
    expect(payments.length).toBe(1);
  });

  // TEST 5 — Worker + Device
  test('TEST 5: Worker + Device identity enforces one record per (worker_id, device_id)', async () => {
    const deviceId = `dev_${Date.now()}_abc`;

    const deviceAttempts = await Promise.allSettled([
      prisma.worker_device.create({
        data: {
          worker_id: workerId1,
          device_id: deviceId,
          fcm_token: `fcm_token_1_${Date.now()}`,
          platform: 'android',
        },
      }),
      prisma.worker_device.create({
        data: {
          worker_id: workerId1,
          device_id: deviceId,
          fcm_token: `fcm_token_2_${Date.now()}`,
          platform: 'android',
        },
      }),
    ]);

    const devFulfilled = deviceAttempts.filter((a) => a.status === 'fulfilled');
    const devRejected = deviceAttempts.filter((a) => a.status === 'rejected');
    expect(devFulfilled.length).toBe(1);
    expect(devRejected.length).toBe(1);
  });

  // TEST 6 — Webhook Event Identity
  test('TEST 6: Webhook event identity enforces uniqueness on (provider, providerEventId)', async () => {
    const provider = 'razorpay';
    const eventId = `evt_${Date.now()}_xyz`;

    const eventAttempts = await Promise.allSettled([
      prisma.paymentWebhookEvent.create({
        data: {
          provider,
          providerEventId: eventId,
          eventType: 'payment.captured',
          status: 'PROCESSED',
        },
      }),
      prisma.paymentWebhookEvent.create({
        data: {
          provider,
          providerEventId: eventId,
          eventType: 'payment.captured',
          status: 'PROCESSED',
        },
      }),
    ]);

    const evtFulfilled = eventAttempts.filter((a) => a.status === 'fulfilled');
    const evtRejected = eventAttempts.filter((a) => a.status === 'rejected');
    expect(evtFulfilled.length).toBe(1);
    expect(evtRejected.length).toBe(1);

    // Cleanup event
    await prisma.paymentWebhookEvent.deleteMany({
      where: { provider, providerEventId: eventId },
    });
  });

  // TEST 7 — Retry Idempotency
  test('TEST 7: Retrying device registration with upsert preserves invariant idempotently', async () => {
    const deviceId = `dev_retry_${Date.now()}`;
    const initialToken = 'fcm_initial_token';
    const rotatedToken = 'fcm_rotated_token';

    // First registration
    const first = await prisma.worker_device.upsert({
      where: {
        worker_id_device_id: {
          worker_id: workerId2,
          device_id: deviceId,
        },
      },
      update: { fcm_token: initialToken, revoked_at: null },
      create: {
        worker_id: workerId2,
        device_id: deviceId,
        fcm_token: initialToken,
        platform: 'android',
      },
    });
    expect(first.fcm_token).toBe(initialToken);

    // Repeated registration / token rotation
    const retry = await prisma.worker_device.upsert({
      where: {
        worker_id_device_id: {
          worker_id: workerId2,
          device_id: deviceId,
        },
      },
      update: { fcm_token: rotatedToken, revoked_at: null },
      create: {
        worker_id: workerId2,
        device_id: deviceId,
        fcm_token: rotatedToken,
        platform: 'android',
      },
    });
    expect(retry.fcm_token).toBe(rotatedToken);
    expect(retry.id).toBe(first.id);

    const count = await prisma.worker_device.count({
      where: { worker_id: workerId2, device_id: deviceId },
    });
    expect(count).toBe(1);
  });

  // TEST 8 — Unique Constraint Error Handling
  test('TEST 8: Direct unique constraint violations trigger P2002 error code', async () => {
    const existing = await prisma.job_dispatch.findFirst({
      where: { requirement_id: requirementId, worker_id: workerId1 },
    });
    expect(existing).not.toBeNull();

    try {
      await prisma.job_dispatch.create({
        data: {
          requirement_id: requirementId,
          worker_id: workerId1,
          status: 'pending',
        },
      });
      fail('Expected Prisma unique constraint violation');
    } catch (err: any) {
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(err.code).toBe('P2002');
    }
  });
});
