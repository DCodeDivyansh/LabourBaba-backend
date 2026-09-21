/**
 * Payment Reconciliation Worker (Issue #69)
 *
 * Runs periodic sweeps to detect stale pending payments and reconcile them with Razorpay.
 */

import { paymentReconciliationService } from "../services/paymentReconciliationService";
import { logger } from "../utils/logger";

class PaymentReconciliationWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  public start(intervalMs = 5 * 60 * 1000): void {
    if (this.timer) return;

    logger.info("[PAYMENT_RECONCILIATION_WORKER] Started periodic reconciliation scheduler.");
    this.timer = setInterval(async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      try {
        await paymentReconciliationService.reconcileStalePayments(15);
      } catch (err: any) {
        logger.error("[PAYMENT_RECONCILIATION_ERROR]", { error: err?.message });
      } finally {
        this.isRunning = false;
      }
    }, intervalMs);

    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("[PAYMENT_RECONCILIATION_WORKER] Stopped periodic reconciliation scheduler.");
    }
  }
}

export const paymentReconciliationWorker = new PaymentReconciliationWorker();
