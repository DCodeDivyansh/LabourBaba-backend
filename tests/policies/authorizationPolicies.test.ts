import { UserRole, AuthenticatedUser } from "../../src/type/userRole";
import {
  jobPolicy,
  requirementPolicy,
  bookingPolicy,
  dispatchPolicy,
  chatPolicy,
  paymentPolicy,
  reviewPolicy,
  workerPolicy,
} from "../../src/policies";

describe("Authorization Policies Unit Tests", () => {
  const customerA: AuthenticatedUser = {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    phone: "+919876543210",
    role: UserRole.CUSTOMER,
  };

  const customerB: AuthenticatedUser = {
    id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    phone: "+919876543211",
    role: UserRole.CUSTOMER,
  };

  const workerA: AuthenticatedUser = {
    id: "11111111-1111-4111-8111-111111111111",
    phone: "+919876543212",
    role: UserRole.WORKER,
  };

  const workerB: AuthenticatedUser = {
    id: "22222222-2222-4222-8222-222222222222",
    phone: "+919876543213",
    role: UserRole.WORKER,
  };

  const admin: AuthenticatedUser = {
    id: "99999999-9999-4999-8999-999999999999",
    phone: "+919876543214",
    role: UserRole.ADMIN,
  };

  // =========================================================================
  // 1. Job Policy
  // =========================================================================
  describe("jobPolicy", () => {
    const jobA = {
      id: "job-a-uuid",
      customer_id: customerA.id,
      status: "OPEN",
      booking: [{ worker_id: workerA.id }],
      job_requirement: [
        {
          job_dispatch: [{ worker_id: workerA.id }],
        },
      ],
    };

    const jobB = {
      id: "job-b-uuid",
      customer_id: customerB.id,
      status: "OPEN",
      booking: [{ worker_id: workerB.id }],
      job_requirement: [],
    };

    it("canCreate: Customer allowed, Worker denied", () => {
      expect(jobPolicy.canCreate(customerA).allowed).toBe(true);
      expect(jobPolicy.canCreate(workerA).allowed).toBe(false);
      expect(jobPolicy.canCreate(workerA).statusCode).toBe(403);
    });

    it("canRead: Customer A can read own jobA, but not jobB", () => {
      expect(jobPolicy.canRead(customerA, jobA).allowed).toBe(true);
      const denied = jobPolicy.canRead(customerA, jobB);
      expect(denied.allowed).toBe(false);
      expect(denied.statusCode).toBe(404);
    });

    it("canRead: Worker A can read jobA (has booking/dispatch), but not jobB", () => {
      expect(jobPolicy.canRead(workerA, jobA).allowed).toBe(true);
      const denied = jobPolicy.canRead(workerA, jobB);
      expect(denied.allowed).toBe(false);
      expect(denied.statusCode).toBe(404);
    });

    it("canRead: Admin can read any job", () => {
      expect(jobPolicy.canRead(admin, jobA).allowed).toBe(true);
      expect(jobPolicy.canRead(admin, jobB).allowed).toBe(true);
    });

    it("canCancel: Only job owner or admin can cancel", () => {
      expect(jobPolicy.canCancel(customerA, jobA).allowed).toBe(true);
      expect(jobPolicy.canCancel(customerB, jobA).allowed).toBe(false);
      expect(jobPolicy.canCancel(workerA, jobA).allowed).toBe(false);
      expect(jobPolicy.canCancel(admin, jobA).allowed).toBe(true);
    });

    it("scopeRead: generates correct database predicates", () => {
      expect(jobPolicy.scopeRead(customerA, "job-1")).toEqual({
        id: "job-1",
        customer_id: customerA.id,
      });
      expect(jobPolicy.scopeRead(admin, "job-1")).toEqual({ id: "job-1" });
    });
  });

  // =========================================================================
  // 2. Requirement Policy
  // =========================================================================
  describe("requirementPolicy", () => {
    const requirementA = {
      id: "req-a-uuid",
      job_id: "job-a-uuid",
      job: { customer_id: customerA.id },
      booking: [{ worker_id: workerA.id }],
    };

    const requirementB = {
      id: "req-b-uuid",
      job_id: "job-b-uuid",
      job: { customer_id: customerB.id },
      booking: [{ worker_id: workerB.id }],
    };

    it("canRead: Customer A can read requirementA, not requirementB", () => {
      expect(requirementPolicy.canRead(customerA, requirementA).allowed).toBe(true);
      expect(requirementPolicy.canRead(customerA, requirementB).allowed).toBe(false);
      expect(requirementPolicy.canRead(customerA, requirementB).statusCode).toBe(404);
    });

    it("canRead: Worker A can read requirementA (assigned), not requirementB", () => {
      expect(requirementPolicy.canRead(workerA, requirementA).allowed).toBe(true);
      expect(requirementPolicy.canRead(workerA, requirementB).allowed).toBe(false);
    });

    it("canRead: Admin can read any requirement", () => {
      expect(requirementPolicy.canRead(admin, requirementA).allowed).toBe(true);
      expect(requirementPolicy.canRead(admin, requirementB).allowed).toBe(true);
    });
  });

  // =========================================================================
  // 3. Booking Policy
  // =========================================================================
  describe("bookingPolicy", () => {
    const bookingA = {
      id: "booking-a-uuid",
      customer_id: customerA.id,
      worker_id: workerA.id,
      status: "CONFIRMED",
    };

    const bookingB = {
      id: "booking-b-uuid",
      customer_id: customerB.id,
      worker_id: workerB.id,
      status: "CONFIRMED",
    };

    it("canRead: Customer A and Worker A can read bookingA; Customer B and Worker B cannot", () => {
      expect(bookingPolicy.canRead(customerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canRead(workerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canRead(customerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canRead(workerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canRead(admin, bookingA).allowed).toBe(true);
    });

    it("canVerifyOtp: Only assigned Worker A can verify OTP for bookingA", () => {
      expect(bookingPolicy.canVerifyOtp(workerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canVerifyOtp(workerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canVerifyOtp(customerA, bookingA).allowed).toBe(false);
    });

    it("canComplete: Only assigned Worker A can complete bookingA", () => {
      expect(bookingPolicy.canComplete(workerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canComplete(workerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canComplete(customerA, bookingA).allowed).toBe(false);
    });

    it("canConfirmCompletion: Only Customer A can confirm completion of bookingA", () => {
      expect(bookingPolicy.canConfirmCompletion(customerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canConfirmCompletion(customerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canConfirmCompletion(workerA, bookingA).allowed).toBe(false);
    });

    it("canCancel: Either participant or admin can cancel", () => {
      expect(bookingPolicy.canCancel(customerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canCancel(workerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canCancel(customerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canCancel(workerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canCancel(admin, bookingA).allowed).toBe(true);
    });

    it("canGetWorkerLocation: Only Customer A or Admin can track worker location", () => {
      expect(bookingPolicy.canGetWorkerLocation(customerA, bookingA).allowed).toBe(true);
      expect(bookingPolicy.canGetWorkerLocation(customerB, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canGetWorkerLocation(workerA, bookingA).allowed).toBe(false);
      expect(bookingPolicy.canGetWorkerLocation(admin, bookingA).allowed).toBe(true);
    });
  });

  // =========================================================================
  // 4. Dispatch Policy
  // =========================================================================
  describe("dispatchPolicy", () => {
    const dispatchA = {
      id: "dispatch-a-uuid",
      requirement_id: "req-a-uuid",
      worker_id: workerA.id,
      status: "PENDING",
    };

    it("canRead: Only Worker A or Admin can read dispatchA", () => {
      expect(dispatchPolicy.canRead(workerA, dispatchA).allowed).toBe(true);
      expect(dispatchPolicy.canRead(workerB, dispatchA).allowed).toBe(false);
      expect(dispatchPolicy.canRead(customerA, dispatchA).allowed).toBe(false);
      expect(dispatchPolicy.canRead(admin, dispatchA).allowed).toBe(true);
    });

    it("canAccept / canDecline: Only Worker A can accept or decline dispatchA", () => {
      expect(dispatchPolicy.canAccept(workerA, dispatchA).allowed).toBe(true);
      expect(dispatchPolicy.canAccept(workerB, dispatchA).allowed).toBe(false);
      expect(dispatchPolicy.canAccept(customerA, dispatchA).allowed).toBe(false);

      expect(dispatchPolicy.canDecline(workerA, dispatchA).allowed).toBe(true);
      expect(dispatchPolicy.canDecline(workerB, dispatchA).allowed).toBe(false);
      expect(dispatchPolicy.canDecline(customerA, dispatchA).allowed).toBe(false);
    });
  });

  // =========================================================================
  // 5. Chat Policy
  // =========================================================================
  describe("chatPolicy", () => {
    const chatBooking = {
      id: "booking-chat-uuid",
      customer_id: customerA.id,
      worker_id: workerA.id,
    };

    it("canReadConversation: Customer A, Worker A, and Admin can read; others denied", () => {
      expect(chatPolicy.canReadConversation(customerA, chatBooking).allowed).toBe(true);
      expect(chatPolicy.canReadConversation(workerA, chatBooking).allowed).toBe(true);
      expect(chatPolicy.canReadConversation(customerB, chatBooking).allowed).toBe(false);
      expect(chatPolicy.canReadConversation(workerB, chatBooking).allowed).toBe(false);
      expect(chatPolicy.canReadConversation(admin, chatBooking).allowed).toBe(true);
    });

    it("canSendMessage: Customer A and Worker A can send; strangers denied", () => {
      expect(chatPolicy.canSendMessage(customerA, chatBooking).allowed).toBe(true);
      expect(chatPolicy.canSendMessage(workerA, chatBooking).allowed).toBe(true);
      expect(chatPolicy.canSendMessage(customerB, chatBooking).allowed).toBe(false);
      expect(chatPolicy.canSendMessage(workerB, chatBooking).allowed).toBe(false);
    });

    it("canJoinRoom: Consistent with conversation read rules", () => {
      expect(chatPolicy.canJoinRoom(customerA, chatBooking).allowed).toBe(true);
      expect(chatPolicy.canJoinRoom(workerA, chatBooking).allowed).toBe(true);
      expect(chatPolicy.canJoinRoom(customerB, chatBooking).allowed).toBe(false);
      expect(chatPolicy.canJoinRoom(workerB, chatBooking).allowed).toBe(false);
      expect(chatPolicy.canJoinRoom(admin, chatBooking).allowed).toBe(true);
    });
  });

  // =========================================================================
  // 6. Payment Policy
  // =========================================================================
  describe("paymentPolicy", () => {
    const paymentBooking = {
      id: "booking-pay-uuid",
      customer_id: customerA.id,
      worker_id: workerA.id,
    };

    it("canCreateOrder: Only Customer A can create order", () => {
      expect(paymentPolicy.canCreateOrder(customerA, paymentBooking).allowed).toBe(true);
      expect(paymentPolicy.canCreateOrder(customerB, paymentBooking).allowed).toBe(false);
      expect(paymentPolicy.canCreateOrder(workerA, paymentBooking).allowed).toBe(false);
    });

    it("canRead: Customer A and Admin can read; Worker A and Customer B denied", () => {
      expect(paymentPolicy.canRead(customerA, paymentBooking).allowed).toBe(true);
      expect(paymentPolicy.canRead(admin, paymentBooking).allowed).toBe(true);
      expect(paymentPolicy.canRead(workerA, paymentBooking).allowed).toBe(false);
      expect(paymentPolicy.canRead(customerB, paymentBooking).allowed).toBe(false);
    });

    it("canRefund: Customer A and Admin can refund; Worker A and Customer B denied", () => {
      expect(paymentPolicy.canRefund(customerA, paymentBooking).allowed).toBe(true);
      expect(paymentPolicy.canRefund(admin, paymentBooking).allowed).toBe(true);
      expect(paymentPolicy.canRefund(workerA, paymentBooking).allowed).toBe(false);
      expect(paymentPolicy.canRefund(customerB, paymentBooking).allowed).toBe(false);
    });
  });

  // =========================================================================
  // 7. Review Policy
  // =========================================================================
  describe("reviewPolicy", () => {
    const reviewBooking = {
      id: "booking-rev-uuid",
      customer_id: customerA.id,
      worker_id: workerA.id,
      status: "COMPLETED",
    };

    it("canCreate: Only Customer A can create review for bookingA", () => {
      expect(reviewPolicy.canCreate(customerA, reviewBooking).allowed).toBe(true);
      expect(reviewPolicy.canCreate(customerB, reviewBooking).allowed).toBe(false);
      expect(reviewPolicy.canCreate(workerA, reviewBooking).allowed).toBe(false);
    });

    it("canReadBookingReview: Customer A, Worker A, and Admin can read", () => {
      expect(reviewPolicy.canReadBookingReview(customerA, reviewBooking).allowed).toBe(true);
      expect(reviewPolicy.canReadBookingReview(workerA, reviewBooking).allowed).toBe(true);
      expect(reviewPolicy.canReadBookingReview(customerB, reviewBooking).allowed).toBe(false);
      expect(reviewPolicy.canReadBookingReview(workerB, reviewBooking).allowed).toBe(false);
      expect(reviewPolicy.canReadBookingReview(admin, reviewBooking).allowed).toBe(true);
    });
  });

  // =========================================================================
  // 8. Worker Policy
  // =========================================================================
  describe("workerPolicy", () => {
    it("canReadSelf / canUpdateSelf: Worker A can read/update self, not Worker B", () => {
      expect(workerPolicy.canReadSelf(workerA, workerA.id).allowed).toBe(true);
      expect(workerPolicy.canReadSelf(workerA, workerB.id).allowed).toBe(false);
      expect(workerPolicy.canReadSelf(admin, workerA.id).allowed).toBe(true);

      expect(workerPolicy.canUpdateSelf(workerA, workerA.id).allowed).toBe(true);
      expect(workerPolicy.canUpdateSelf(workerA, workerB.id).allowed).toBe(false);
      expect(workerPolicy.canUpdateSelf(customerA, workerA.id).allowed).toBe(false);
    });

    it("canReadDocuments: Worker A and Admin can read; Customer A and Worker B STRICTLY DENIED", () => {
      expect(workerPolicy.canReadDocuments(workerA, workerA.id).allowed).toBe(true);
      expect(workerPolicy.canReadDocuments(admin, workerA.id).allowed).toBe(true);
      expect(workerPolicy.canReadDocuments(workerB, workerA.id).allowed).toBe(false);
      expect(workerPolicy.canReadDocuments(customerA, workerA.id).allowed).toBe(false);
      expect(workerPolicy.canReadDocuments(customerA, workerA.id).statusCode).toBe(403);
    });

    it("canAdminVerify / canAdminSuspend: Only Admin can verify or suspend", () => {
      expect(workerPolicy.canAdminVerify(admin).allowed).toBe(true);
      expect(workerPolicy.canAdminVerify(workerA).allowed).toBe(false);
      expect(workerPolicy.canAdminVerify(customerA).allowed).toBe(false);

      expect(workerPolicy.canAdminSuspend(admin).allowed).toBe(true);
      expect(workerPolicy.canAdminSuspend(workerA).allowed).toBe(false);
      expect(workerPolicy.canAdminSuspend(customerA).allowed).toBe(false);
    });
  });
});
