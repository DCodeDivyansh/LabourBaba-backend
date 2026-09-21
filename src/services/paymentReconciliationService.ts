/**
 * Payment Reconciliation Service — Issue 69
 *
 * Guarantees:
 * 1. Identifies stale PENDING payments and queries the authoritative provider state from Razorpay.
 * 2. Reconciles captured payments and detects lost or delayed webhooks.
 * 3. Never blindly overwrites state: validates amounts and currencies; quarantines mismatches.
 * 4. Idempotent and concurrency-safe across multiple worker instances.
 */

import prisma from "../config/prisma";
import {
  fetchOrder,
  fetchPayment,
  RazorpayProviderError,
} from "../providers/razorpay/razorpayProvider";
import {
  PaymentStatus,
  transitionPaymentStatus,
} from "../features/payment/paymentServices";
import { auditService } from "../features/audit/audit.service";
import { logger } from "../utils/logger";

export interface ReconciliationResult {
  totalEvaluated: number;
  reconciledCompleted: number;
  reconciledFailed: number;
  quarantined: number;
  skipped: number;
  errors: number;
}

export class PaymentReconciliationService {
  /**
   * Reconciles stale PENDING payments older than a configured threshold.
   */
  async reconcileStalePayments(olderThanMinutes = 15): Promise<ReconciliationResult> {
    const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000);

    const stalePayments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        created_at: { lt: cutoffTime },
        quarantine_reason: null, // Skip already-quarantined records
      },
      take: 50,
      orderBy: { created_at: "asc" },
    });

    const result: ReconciliationResult = {
      totalEvaluated: stalePayments.length,
      reconciledCompleted: 0,
      reconciledFailed: 0,
      quarantined: 0,
      skipped: 0,
      errors: 0,
    };

    for (const payment of stalePayments) {
      if (!payment.razorpay_order_id) {
        result.skipped++;
        continue;
      }

      try {
        const providerOrder = await fetchOrder(payment.razorpay_order_id);

        if (providerOrder.status === "paid") {
          // Amount & Currency Reconciliation check
          if (payment.amount !== null && providerOrder.amount !== payment.amount) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                quarantine_reason: `Reconciliation amount mismatch: local=${payment.amount}p, provider=${providerOrder.amount}p`,
                updated_at: new Date(),
              },
            });
            result.quarantined++;
            continue;
          }

          if (
            payment.currency &&
            providerOrder.currency.toUpperCase() !== payment.currency.toUpperCase()
          ) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                quarantine_reason: `Reconciliation currency mismatch: local=${payment.currency}, provider=${providerOrder.currency}`,
                updated_at: new Date(),
              },
            });
            result.quarantined++;
            continue;
          }

          // Atomically transition to COMPLETED
          await prisma.$transaction(async (tx) => {
            const transitioned = await transitionPaymentStatus(
              tx,
              payment.id,
              PaymentStatus.PENDING,
              PaymentStatus.COMPLETED,
            );
            if (transitioned) {
              result.reconciledCompleted++;
            }
          });

          await auditService.recordEvent(prisma, {
            action: "PAYMENT_RECONCILED_COMPLETED",
            actorId: "system_reconciliation_worker",
            actorRole: "system",
            targetId: payment.id,
            targetType: "payment",
            metadata: {
              orderId: payment.razorpay_order_id,
              amount: providerOrder.amount,
            },
          }).catch((err) => logger.warn("[AUDIT_RECORD_FAILED]", { error: err.message }));
        } else if (providerOrder.status === "created" && providerOrder.attempts > 3) {
          // Exceeded attempts without payment — transition to FAILED
          await prisma.$transaction(async (tx) => {
            await transitionPaymentStatus(
              tx,
              payment.id,
              PaymentStatus.PENDING,
              PaymentStatus.FAILED,
            );
            result.reconciledFailed++;
          });
        } else {
          result.skipped++;
        }
      } catch (err: any) {
        result.errors++;
        logger.warn("[RECONCILIATION_ORDER_ERROR]", {
          paymentId: payment.id,
          orderId: payment.razorpay_order_id,
          error: err?.message,
        });
      }
    }

    logger.info("[PAYMENT_RECONCILIATION_RUN]", { ...result });
    return result;
  }
}

export const paymentReconciliationService = new PaymentReconciliationService();
