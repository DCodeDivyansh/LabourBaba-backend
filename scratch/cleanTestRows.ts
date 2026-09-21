import prisma from "../src/config/prisma";

async function main() {
  await prisma.job_dispatch.deleteMany({
    where: {
      job_requirement: {
        job: { customer: { phone: { startsWith: "+919999900" } } }
      }
    }
  });

  await prisma.booking.deleteMany({
    where: {
      customer: { phone: { startsWith: "+919999900" } }
    }
  });

  await prisma.job_requirement.deleteMany({
    where: {
      job: { customer: { phone: { startsWith: "+919999900" } } }
    }
  });

  await prisma.job.deleteMany({
    where: {
      customer: { phone: { startsWith: "+919999900" } }
    }
  });

  await prisma.customer.deleteMany({
    where: { phone: { startsWith: "+919999900" } }
  });

  console.log("Cleanup completed successfully");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
