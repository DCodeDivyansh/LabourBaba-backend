const prisma = require('../src/config/prisma').default;

async function check() {
  const custCount = await prisma.customer.count();
  const workerCount = await prisma.worker.count();
  const jobCount = await prisma.job.count();
  const bookingCount = await prisma.booking.count();
  console.log('CLOUD DB -> Customers:', custCount, 'Workers:', workerCount, 'Jobs:', jobCount, 'Bookings:', bookingCount);
  await prisma.$disconnect();
}

check().catch(console.error);
