const fs = require('fs');
const path = require('path');

const jsonPath = path.resolve(__dirname, '../LABOURBABA_ACTUAL_FEATURES.json');
const features = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// Corrections map:
for (const f of features) {
  if (f.id === 'AUTH-001') {
    f.httpEndpoints = ['POST /api/customers/signup', 'POST /api/customers/add'];
    f.databaseModels = ['customer', 'refresh_session'];
  } else if (f.id === 'AUTH-002') {
    f.httpEndpoints = ['POST /api/workers/registerWorker'];
    f.databaseModels = ['Worker', 'refresh_session'];
  } else if (f.id === 'AUTH-003') {
    f.httpEndpoints = ['POST /api/auth/send-otp'];
    f.databaseModels = ['otp_challenge'];
  } else if (f.id === 'AUTH-004') {
    f.httpEndpoints = ['POST /api/auth/verify-otp'];
    f.databaseModels = ['customer', 'Worker', 'refresh_session'];
  } else if (f.id === 'AUTH-005') {
    f.httpEndpoints = ['POST /api/customers/login'];
    f.databaseModels = ['customer', 'refresh_session'];
  } else if (f.id === 'AUTH-006') {
    f.httpEndpoints = ['POST /api/workers/login'];
    f.databaseModels = ['Worker', 'refresh_session'];
  } else if (f.id === 'AUTH-007') {
    f.httpEndpoints = ['POST /api/auth/refresh'];
    f.databaseModels = ['refresh_session'];
  } else if (f.id === 'AUTH-008') {
    f.httpEndpoints = ['POST /api/auth/logout'];
    f.databaseModels = ['refresh_session'];
  } else if (f.id === 'AUTH-009') {
    f.httpEndpoints = ['GET /api/auth/sessions', 'DELETE /api/auth/sessions/:sessionId', 'DELETE /api/auth/sessions'];
    f.databaseModels = ['refresh_session'];
  } else if (f.id === 'CUST-001') {
    f.httpEndpoints = ['GET /api/customers/me', 'POST /api/customers/add'];
    f.databaseModels = ['customer'];
  } else if (f.id === 'CUST-002') {
    f.httpEndpoints = ['POST /api/customers/me/devices', 'GET /api/customers/me/devices', 'DELETE /api/customers/me/devices/:deviceId'];
    f.databaseModels = ['customer_device'];
  } else if (f.id === 'CUST-003') {
    f.httpEndpoints = ['GET /api/customers/notifications', 'GET /api/customers/notifications/unread', 'POST /api/customers/notifications/:id/ack', 'POST /api/customers/notifications/ack-all'];
    f.databaseModels = ['notification', 'notification_outbox'];
  } else if (f.id === 'WRK-001') {
    f.httpEndpoints = ['GET /api/workers/me', 'PATCH /api/workers/me'];
    f.databaseModels = ['Worker', 'worker_skill'];
  } else if (f.id === 'WRK-002') {
    f.httpEndpoints = ['PATCH /api/workers/me/online'];
    f.databaseModels = ['Worker'];
  } else if (f.id === 'WRK-003') {
    f.httpEndpoints = ['POST /api/workers/me/documents/upload-url', 'POST /api/workers/me/documents'];
    f.databaseModels = ['worker_document', 'Worker'];
  } else if (f.id === 'WRK-004') {
    f.httpEndpoints = ['GET /api/workers/me/documents/:documentId/access'];
    f.databaseModels = ['worker_document'];
  } else if (f.id === 'WRK-005') {
    f.httpEndpoints = ['GET /api/workers/me/bookings'];
    f.databaseModels = ['booking', 'job', 'customer'];
  } else if (f.id === 'WRK-006') {
    f.httpEndpoints = ['GET /api/workers/me/earnings', 'GET /api/workers/me/analytics'];
    f.databaseModels = ['booking', 'payment', 'worker_analytics'];
  } else if (f.id === 'WRK-007') {
    f.httpEndpoints = ['POST /api/workers/me/devices', 'GET /api/workers/me/devices', 'DELETE /api/workers/me/devices/:deviceId', 'PATCH /api/workers/me/device-token'];
    f.databaseModels = ['worker_device'];
  } else if (f.id === 'JOB-001') {
    f.httpEndpoints = ['POST /api/jobs'];
    f.databaseModels = ['job', 'job_requirement', 'job_requirement_skill'];
  } else if (f.id === 'JOB-002') {
    f.httpEndpoints = ['GET /api/jobs'];
    f.databaseModels = ['job', 'job_requirement', 'booking'];
  } else if (f.id === 'JOB-003') {
    f.httpEndpoints = ['GET /api/jobs/:jobId'];
    f.databaseModels = ['job', 'job_requirement', 'booking', 'Worker'];
  } else if (f.id === 'JOB-004') {
    f.httpEndpoints = ['POST /api/jobs/:jobId/requirements', 'PATCH /api/jobs/:jobId/requirements/:requirementId/demand'];
    f.databaseModels = ['job_requirement', 'job_requirement_skill'];
  } else if (f.id === 'JOB-005') {
    f.httpEndpoints = ['PATCH /api/jobs/:jobId/cancel'];
    f.databaseModels = ['job', 'job_requirement', 'booking', 'job_dispatch'];
  } else if (f.id === 'LOC-001') {
    f.httpEndpoints = ['POST /api/worker_location/add', 'PATCH /api/workers/me/location'];
    f.databaseModels = ['Worker', 'worker_location'];
  } else if (f.id === 'LOC-002') {
    f.databaseModels = ['Worker', 'worker_location'];
  } else if (f.id === 'LOC-003') {
    f.httpEndpoints = ['GET /api/bookings/:bookingId/location'];
    f.databaseModels = ['booking', 'Worker'];
  } else if (f.id === 'DISP-001') {
    f.databaseModels = ['Worker', 'worker_skill', 'worker_location'];
  } else if (f.id === 'DISP-002') {
    f.databaseModels = ['dispatch_wave', 'job_dispatch'];
  } else if (f.id === 'DISP-003') {
    f.httpEndpoints = ['GET /api/dispatch/incoming', 'GET /api/dispatch/:requirementId'];
    f.databaseModels = ['job_dispatch', 'job', 'job_requirement'];
  } else if (f.id === 'DISP-004') {
    f.httpEndpoints = ['POST /api/dispatch/:requirementId/accept'];
    f.databaseModels = ['job_dispatch', 'booking', 'job_requirement', 'job', 'Worker'];
  } else if (f.id === 'DISP-005') {
    f.httpEndpoints = ['POST /api/dispatch/:requirementId/decline'];
    f.databaseModels = ['job_dispatch'];
  } else if (f.id === 'DISP-006') {
    f.databaseModels = ['dispatch_wave', 'job_dispatch'];
  } else if (f.id === 'BKG-001') {
    f.httpEndpoints = ['GET /api/bookings/:bookingId'];
    f.databaseModels = ['booking', 'job', 'customer', 'Worker', 'payment'];
  } else if (f.id === 'BKG-002') {
    f.httpEndpoints = ['POST /api/bookings/:bookingId/otp/verify'];
    f.databaseModels = ['booking', 'booking_transition'];
  } else if (f.id === 'BKG-003') {
    f.httpEndpoints = ['POST /api/bookings/:bookingId/complete'];
    f.databaseModels = ['booking', 'booking_transition'];
  } else if (f.id === 'BKG-004') {
    f.httpEndpoints = ['POST /api/bookings/:bookingId/confirm-complete'];
    f.databaseModels = ['booking', 'Worker', 'booking_transition'];
  } else if (f.id === 'BKG-005') {
    f.httpEndpoints = ['POST /api/bookings/:bookingId/cancel'];
    f.databaseModels = ['booking', 'Worker', 'booking_transition'];
  } else if (f.id === 'PAY-001') {
    f.httpEndpoints = ['POST /api/payments/:bookingId/create-order'];
    f.databaseModels = ['payment', 'booking'];
  } else if (f.id === 'PAY-002') {
    f.httpEndpoints = ['POST /api/payments/webhook'];
    f.databaseModels = ['payment', 'PaymentWebhookEvent', 'booking'];
  } else if (f.id === 'PAY-003') {
    f.httpEndpoints = ['GET /api/payments/:bookingId', 'GET /api/bookings/:bookingId/payment'];
    f.databaseModels = ['payment'];
  } else if (f.id === 'PAY-004') {
    f.status = 'IMPLEMENTED';
    f.evidenceLevel = 'B';
    f.runtimeVerified = true;
    f.httpEndpoints = ['POST /api/payments/:bookingId/refund'];
    f.databaseModels = ['payment', 'notification_outbox'];
    f.notes = ['Executes real razorpay.payments.refund SDK call; captures refundId and writes REFUND_COMPLETED outbox event'];
  } else if (f.id === 'PAY-005') {
    f.databaseModels = ['payment'];
  } else if (f.id === 'CHAT-001') {
    f.databaseModels = ['conversation', 'message', 'booking'];
  } else if (f.id === 'CHAT-002') {
    f.httpEndpoints = ['GET /api/chat/:bookingId/messages'];
    f.databaseModels = ['conversation', 'message'];
  } else if (f.id === 'CHAT-003') {
    f.httpEndpoints = ['POST /api/chat/:bookingId/messages'];
    f.databaseModels = ['conversation', 'message', 'notification_outbox'];
  } else if (f.id === 'NOTIF-001') {
    f.databaseModels = ['notification_outbox', 'notification_delivery'];
  } else if (f.id === 'NOTIF-002') {
    f.databaseModels = ['customer_device', 'worker_device'];
  } else if (f.id === 'NOTIF-003') {
    f.databaseModels = ['notification'];
  } else if (f.id === 'SKILL-001') {
    f.httpEndpoints = ['GET /api/skill/'];
    f.databaseModels = ['skill_category'];
  } else if (f.id === 'SKILL-002') {
    f.httpEndpoints = ['POST /api/skill/add', 'PATCH /api/skill/:skillId/status'];
    f.databaseModels = ['skill_category'];
  } else if (f.id === 'REV-001') {
    f.httpEndpoints = ['POST /api/reviews/:bookingId'];
    f.databaseModels = ['review', 'Worker', 'booking'];
  } else if (f.id === 'REV-002') {
    f.httpEndpoints = ['GET /api/reviews/worker/:workerId', 'GET /api/reviews/:bookingId'];
    f.databaseModels = ['review', 'customer'];
  } else if (f.id === 'ADM-001') {
    f.httpEndpoints = ['GET /api/admin/workers'];
    f.databaseModels = ['Worker', 'worker_document'];
  } else if (f.id === 'ADM-002') {
    f.httpEndpoints = ['GET /api/admin/workers/:id/documents/:documentId/access', 'GET /api/admin/workers/:id/documents'];
    f.databaseModels = ['worker_document'];
  } else if (f.id === 'ADM-003') {
    f.httpEndpoints = ['PATCH /api/admin/workers/:id/verify'];
    f.databaseModels = ['worker_document', 'Worker'];
  } else if (f.id === 'ADM-004') {
    f.httpEndpoints = ['POST /api/admin/workers/:id/suspend'];
    f.databaseModels = ['Worker', 'refresh_session'];
  } else if (f.id === 'ADM-005') {
    f.httpEndpoints = ['GET /api/admin/jobs', 'GET /api/admin/flagged'];
    f.databaseModels = ['job', 'booking', 'Worker'];
  } else if (f.id === 'ADM-006') {
    f.httpEndpoints = ['GET /api/admin/audit-logs'];
    f.databaseModels = ['audit_log'];
  }
}

fs.writeFileSync(jsonPath, JSON.stringify(features, null, 2), 'utf8');
console.log('Successfully updated LABOURBABA_ACTUAL_FEATURES.json with verified routes and models.');

const artJson = 'C:/Users/Divy/.gemini/antigravity-ide/brain/1ffaea16-62d0-4cfa-a0c2-5548118ade26/LABOURBABA_ACTUAL_FEATURES.json';
fs.copyFileSync(jsonPath, artJson);
console.log('Updated artifact copy of LABOURBABA_ACTUAL_FEATURES.json');
