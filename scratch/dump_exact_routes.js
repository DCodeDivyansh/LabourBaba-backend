const path = require('path');

// We can import each router file and inspect its router.stack directly!
const routers = [
  { prefix: '/health', file: '../src/features/health/healthRoutes' },
  { prefix: '/api/clients', file: '../src/features/auth/customerRoutes' },
  { prefix: '/api/customers', file: '../src/features/auth/customerRoutes' },
  { prefix: '/api/workers', file: '../src/features/worker/workerRoutes' },
  { prefix: '/api/skill', file: '../src/features/skill/skillRouter' },
  { prefix: '/api/worker_location', file: '../src/features/worker_location/worker_location.routes' },
  { prefix: '/api/jobs', file: '../src/features/jobs/jobRoutes' },
  { prefix: '/api/auth', file: '../src/features/auth/auth.routes' },
  { prefix: '/api/dispatch', file: '../src/features/dispatch/dispatchRoutes' },
  { prefix: '/api/bookings', file: '../src/features/booking/bookingRoutes' },
  { prefix: '/api/payments', file: '../src/features/payment/paymentRoutes' },
  { prefix: '/api/reviews', file: '../src/features/review/reviewRoutes' },
  { prefix: '/api/chat', file: '../src/features/chat/chatRoutes' },
  { prefix: '/api/admin', file: '../src/features/admin/adminRoutes' },
  { prefix: '/api/storage', file: '../src/providers/storage/storage.routes' },
  { prefix: '', file: '../src/providers/storage/storage.routes' },
];

process.env.NODE_ENV = 'test';

const routeList = [];

// Add top-level routes from server.ts
routeList.push({ method: 'GET', fullPath: '/metrics', handler: 'metricsService', middlewares: [] });

for (const { prefix, file } of routers) {
  try {
    const mod = require(file);
    const router = mod.default || mod;
    if (router && router.stack) {
      for (const layer of router.stack) {
        if (layer.route) {
          const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
          const subPath = layer.route.path === '/' ? '' : layer.route.path;
          const fullPath = (prefix + subPath) || '/';
          const middlewares = layer.route.stack.map(s => s.name || 'anonymous');
          for (const method of methods) {
            routeList.push({
              method,
              fullPath,
              middlewares,
              file
            });
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to load ${file}:`, err.message);
  }
}

console.log(`Audited ${routeList.length} total route entries.`);
const fs = require('fs');
fs.writeFileSync('scratch/actual_routes_dump.json', JSON.stringify(routeList, null, 2));
console.log('Saved to scratch/actual_routes_dump.json');
