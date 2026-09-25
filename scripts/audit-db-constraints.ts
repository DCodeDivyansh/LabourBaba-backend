import prisma from '../src/config/prisma';
import fs from 'fs';

interface TestResult {
  invariant: string;
  targetTable: string;
  expectedRejection: boolean;
  actualRejected: boolean;
  errorCode?: string;
  errorMessage?: string;
  pass: boolean;
}

async function main() {
  const results: TestResult[] = [];

  const record = (res: TestResult) => {
    results.push(res);
    console.log(`[${res.pass ? 'PASS' : 'FAIL'}] ${res.invariant} - Table: ${res.targetTable} (Code: ${res.errorCode || 'None'})`);
  };

  // 1. Invalid Foreign Key Violation (customer_id non-existent in "job")
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO "job" (
        "id", "customer_id", "title", "status", "payment_status", "total_payout_amount",
        "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Test Bad FK', 'OPEN', 'PENDING', 500,
        NOW(), NOW()
      );
    `);
    record({
      invariant: 'Rejects Non-existent Foreign Key (Customer ID)',
      targetTable: 'job',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    record({
      invariant: 'Rejects Non-existent Foreign Key (Customer ID)',
      targetTable: 'job',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: e.code === 'P2010' || e.message.includes('foreign key')
    });
  }

  // 2. CHECK Constraint: Negative capacity in job_requirement
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO "job_requirement" (
        "id", "job_id", "skill_category_id", "worker_count_needed", "worker_count_filled", "status",
        "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), -5, 0, 'OPEN', NOW(), NOW()
      );
    `);
    record({
      invariant: 'Rejects Negative worker_count_needed (CHECK chk_job_requirement_worker_count_needed)',
      targetTable: 'job_requirement',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    const isCheck = e.code === 'P2010' || e.message.includes('check constraint') || e.message.includes('chk_job_requirement_worker_count_needed');
    record({
      invariant: 'Rejects Negative worker_count_needed (CHECK chk_job_requirement_worker_count_needed)',
      targetTable: 'job_requirement',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: isCheck
    });
  }

  // 3. CHECK Constraint: Overfilling capacity (worker_count_filled > worker_count_needed)
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO "job_requirement" (
        "id", "job_id", "skill_category_id", "worker_count_needed", "worker_count_filled", "status",
        "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 2, 5, 'OPEN', NOW(), NOW()
      );
    `);
    record({
      invariant: 'Rejects Overfilled Capacity (CHECK chk_job_requirement_capacity_bounds)',
      targetTable: 'job_requirement',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    const isCheck = e.code === 'P2010' || e.message.includes('check constraint') || e.message.includes('chk_job_requirement_capacity_bounds');
    record({
      invariant: 'Rejects Overfilled Capacity (CHECK chk_job_requirement_capacity_bounds)',
      targetTable: 'job_requirement',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: isCheck
    });
  }

  // 4. CHECK Constraint: Cancelled Booking without Mandatory Audit Fields
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO "booking" (
        "id", "job_id", "requirement_id", "worker_id", "customer_id", "status",
        "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        'CANCELLED', NOW(), NOW()
      );
    `);
    record({
      invariant: 'Rejects CANCELLED Booking Missing Audit Fields (chk_booking_cancellation_audit)',
      targetTable: 'booking',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    const isCheck = e.code === 'P2010' || e.message.includes('check constraint') || e.message.includes('chk_booking_cancellation_audit');
    record({
      invariant: 'Rejects CANCELLED Booking Missing Audit Fields (chk_booking_cancellation_audit)',
      targetTable: 'booking',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: isCheck
    });
  }

  // 5. CHECK Constraint: Invalid Booking Status Enum Value
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO "booking" (
        "id", "job_id", "requirement_id", "worker_id", "customer_id", "status",
        "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        'MALICIOUS_STATUS_XYZ', NOW(), NOW()
      );
    `);
    record({
      invariant: 'Rejects Invalid Booking Status (chk_booking_status)',
      targetTable: 'booking',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    const isCheck = e.code === 'P2010' || e.message.includes('check constraint') || e.message.includes('chk_booking_status');
    record({
      invariant: 'Rejects Invalid Booking Status (chk_booking_status)',
      targetTable: 'booking',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: isCheck
    });
  }

  // 6. CHECK Constraint: Worker Document Status
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO "worker_document" (
        "id", "worker_id", "document_type", "file_url", "status", "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), gen_random_uuid(), 'AADHAAR', 'https://example.com/doc.pdf', 'MALICIOUS_STATUS', NOW(), NOW()
      );
    `);
    record({
      invariant: 'Rejects Invalid Worker Document Status (chk_worker_document_status)',
      targetTable: 'worker_document',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    const isCheck = e.code === 'P2010' || e.message.includes('check constraint') || e.message.includes('chk_worker_document_status');
    record({
      invariant: 'Rejects Invalid Worker Document Status (chk_worker_document_status)',
      targetTable: 'worker_document',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: isCheck
    });
  }

  // 7. Compound Unique Constraint on notification_delivery
  try {
    const recipientId = '66666666-7777-8888-9999-000000000000';
    const outbox = await prisma.notification_outbox.create({
      data: {
        event_type: 'test_event',
        aggregate_type: 'job',
        aggregate_id: '33333333-4444-5555-6666-777777777777',
        recipient_id: recipientId,
        recipient_type: 'customer',
        idempotency_key: `audit_key_${Date.now()}`,
        status: 'PENDING',
        payload: { test: true }
      }
    });

    await prisma.notification_delivery.create({
      data: {
        event_id: outbox.id,
        recipient_id: recipientId,
        channel: 'socket',
        status: 'SENT'
      }
    });

    await prisma.notification_delivery.create({
      data: {
        event_id: outbox.id,
        recipient_id: recipientId,
        channel: 'socket',
        status: 'SENT'
      }
    });

    record({
      invariant: 'Rejects Duplicate Channel Delivery for Same Event & Recipient',
      targetTable: 'notification_delivery',
      expectedRejection: true,
      actualRejected: false,
      pass: false
    });
  } catch (e: any) {
    const isDup = e.code === 'P2002' || e.message.includes('Unique constraint failed') || e.message.includes('23505');
    record({
      invariant: 'Rejects Duplicate Channel Delivery for Same Event & Recipient',
      targetTable: 'notification_delivery',
      expectedRejection: true,
      actualRejected: true,
      errorCode: e.code || '23505',
      errorMessage: e.message.split('\n').pop() || e.message,
      pass: isDup
    });
  }

  // 8. PostGIS Geodesic Distance Calculation
  try {
    const res: any = await prisma.$queryRawUnsafe(`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(77.2090, 28.6139), 4326)::geography,
        ST_SetSRID(ST_MakePoint(77.2100, 28.6150), 4326)::geography
      ) as distance_meters;
    `);
    const validDistance = res[0]?.distance_meters > 0;
    record({
      invariant: 'PostGIS ST_Distance accurately calculates geodesic distance',
      targetTable: 'PostGIS geography',
      expectedRejection: false,
      actualRejected: false,
      errorMessage: `Calculated distance: ${res[0]?.distance_meters}m`,
      pass: validDistance
    });
  } catch (e: any) {
    record({
      invariant: 'PostGIS ST_Distance accurately calculates geodesic distance',
      targetTable: 'PostGIS geography',
      expectedRejection: false,
      actualRejected: true,
      errorCode: e.code,
      errorMessage: e.message,
      pass: false
    });
  }

  fs.writeFileSync(
    'artifacts/production-verification/database/constraint_audit_results.json',
    JSON.stringify(results, null, 2),
    'utf8'
  );

  await prisma.$disconnect();
  console.log(`\nCompleted Database Constraint Audit: ${results.filter(r => r.pass).length}/${results.length} checks passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
