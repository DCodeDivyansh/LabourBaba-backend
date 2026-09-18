import {
  toWorkerPublicDTO,
  toWorkerSelfDTO,
  toWorkerAdminDTO,
  toWorkerDocumentDTO,
  toWorkerAnalyticsDTO,
  toWorkerLocationDTO,
  toCustomerSummaryDTO,
  toCustomerSelfDTO,
  toCustomerPublicDTO,
  toAuthUserDTO,
  toSkillCategoryDTO,
  toJobDTO,
  toJobRequirementDTO,
  toDispatchDTO,
  toDispatchWaveDTO,
  toPaymentDTO,
  toReviewDTO,
  toBookingDTO,
  toChatMessageDTO,
  toConversationDTO,
} from "../src/shared/prismaSelects";

describe("DTO Allowlist & Future-Field Immunity Tests (Issue #4)", () => {
  // Typical malicious/internal injected payload containing all categories of sensitive database columns
  const POISONED_PAYLOAD = {
    password: "plaintext_password_123",
    password_hash: "$2b$10$e8wX9aKz43Q8t7Jz/e3W2.1234567890abcdef",
    passwordHash: "hash_camel_case",
    otp: "123456",
    otp_hash: "$2b$10$otpHashSecret123456",
    otpHash: "otp_hash_camel_case",
    refresh_token: "jwt_refresh_token_secret",
    refreshToken: "jwt_refresh_token_camel",
    refresh_token_hash: "hash_of_refresh_token",
    access_token: "secret_access_token",
    device_token: "fcm_device_token_secret_123456",
    push_token: "push_token_secret",
    location_geo: "0101000020E6100000...", // PostGIS internal binary
    storage_key: "s3://private-bucket/identity/aadhaar.pdf",
    private_document_key: "identity_raw_key_secret",
    internal_status: "FLAGGED_FOR_FRAUD",
    verification_metadata: { ip: "192.168.1.1", fraud_score: 99 },
    admin_notes: "Suspicious activity detected on worker account",
    internal_id: "int_sys_id_9999",
    audit_fields: { created_by: "system_admin", last_login_ip: "10.0.0.1" },
    future_prisma_column: "FUTURE_PRISMA_COLUMN_THAT_MUST_NEVER_LEAK",
    future_security_flag: "DO_NOT_EXPOSE",
  };

  describe("1. Worker DTOs", () => {
    it("toWorkerPublicDTO MUST be an explicit allowlist and block all sensitive/future fields", () => {
      const source = {
        id: "w-123",
        name: "Ramesh Kumar",
        skill_type: "Plumber",
        worker_score: 4.8,
        is_online: true,
        skill_category_id: "cat-1",
        phone: "+919876543210",
        latitude: 19.076,
        longitude: 72.8777,
        ...POISONED_PAYLOAD,
      };

      const dto = toWorkerPublicDTO(source);
      expect(dto).toBeDefined();

      // Assert expected allowlisted fields
      expect(dto).toEqual({
        id: "w-123",
        name: "Ramesh Kumar",
        skill_type: "Plumber",
        worker_score: 4.8,
        is_online: true,
        skill_category_id: "cat-1",
        phone: "+919876543210",
        latitude: 19.076,
        longitude: 72.8777,
      });

      // Assert forbidden fields are absent
      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("password_hash");
      expect(dto).not.toHaveProperty("device_token");
      expect(dto).not.toHaveProperty("location_geo");
      expect(dto).not.toHaveProperty("admin_notes");
      expect(dto).not.toHaveProperty("future_prisma_column");
    });

    it("toWorkerSelfDTO MUST exclude password and device_token while exposing verified self metadata", () => {
      const source = {
        id: "w-123",
        name: "Ramesh Kumar",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "cat-1",
        worker_score: 4.8,
        is_online: true,
        aadhaar_last4: "4321",
        verification_status: "verified",
        skill_category: { id: "cat-1", name: "Plumbing", ...POISONED_PAYLOAD },
        ...POISONED_PAYLOAD,
      };

      const dto = toWorkerSelfDTO(source);
      expect(dto).toBeDefined();

      expect(dto).toEqual({
        id: "w-123",
        name: "Ramesh Kumar",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "cat-1",
        worker_score: 4.8,
        is_online: true,
        aadhaar_last4: "4321",
        verification_status: "verified",
        skill_category: { id: "cat-1", name: "Plumbing" },
      });

      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("device_token");
      expect(dto).not.toHaveProperty("future_prisma_column");
      expect(dto?.skill_category).not.toHaveProperty("future_prisma_column");
    });

    it("toWorkerAdminDTO MUST exclude raw password and device tokens while allowlisting admin oversight fields", () => {
      const source = {
        id: "w-123",
        name: "Ramesh Kumar",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "cat-1",
        worker_score: 4.8,
        is_online: true,
        aadhaar_last4: "4321",
        verification_status: "verified",
        decline_count: 2,
        timeout_count: 1,
        ...POISONED_PAYLOAD,
      };

      const dto = toWorkerAdminDTO(source);
      expect(dto).toEqual({
        id: "w-123",
        name: "Ramesh Kumar",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "cat-1",
        worker_score: 4.8,
        is_online: true,
        aadhaar_last4: "4321",
        verification_status: "verified",
        decline_count: 2,
        timeout_count: 1,
      });

      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("password_hash");
      expect(dto).not.toHaveProperty("device_token");
      expect(dto).not.toHaveProperty("future_prisma_column");
    });

    it("toWorkerDocumentDTO MUST exclude private storage keys and internal audit fields", () => {
      const source = {
        id: "doc-1",
        worker_id: "w-123",
        document_type: "AADHAAR",
        file_url: "https://storage.labourbaba.com/signed/doc-1.pdf",
        status: "VERIFIED",
        ...POISONED_PAYLOAD,
      };

      const dto = toWorkerDocumentDTO(source);
      expect(dto).toEqual({
        id: "doc-1",
        worker_id: "w-123",
        document_type: "AADHAAR",
        file_url: "https://storage.labourbaba.com/signed/doc-1.pdf",
        status: "VERIFIED",
      });

      expect(dto).not.toHaveProperty("storage_key");
      expect(dto).not.toHaveProperty("private_document_key");
      expect(dto).not.toHaveProperty("future_prisma_column");
    });

    it("toWorkerAnalyticsDTO MUST allowlist analytics metrics without internal calculation flags", () => {
      const now = new Date();
      const source = {
        id: "ana-1",
        worker_id: "w-123",
        avg_response_time_s: 15,
        acceptance_rate: 0.95,
        completion_rate: 0.98,
        calculated_at: now,
        ...POISONED_PAYLOAD,
      };

      const dto = toWorkerAnalyticsDTO(source);
      expect(dto).toEqual({
        id: "ana-1",
        worker_id: "w-123",
        avg_response_time_s: 15,
        acceptance_rate: 0.95,
        completion_rate: 0.98,
        calculated_at: now,
      });
      expect(dto).not.toHaveProperty("future_prisma_column");
    });

    it("toWorkerLocationDTO MUST sanitize worker location and exclude internal GIS binary", () => {
      const now = new Date();
      const source = {
        id: "loc-1",
        worker_id: "w-123",
        latitude: 19.076,
        longitude: 72.8777,
        location: "Mumbai, MH",
        updated_at: now,
        ...POISONED_PAYLOAD,
      };

      const dto = toWorkerLocationDTO(source);
      expect(dto).toEqual({
        id: "loc-1",
        worker_id: "w-123",
        latitude: 19.076,
        longitude: 72.8777,
        location: "Mumbai, MH",
        updated_at: now,
      });
      expect(dto).not.toHaveProperty("location_geo");
      expect(dto).not.toHaveProperty("future_prisma_column");
    });
  });

  describe("2. Customer DTOs", () => {
    it("toCustomerSelfDTO MUST allowlist customer profile and exclude password/deleted_at/tokens", () => {
      const now = new Date();
      const source = {
        id: "c-123",
        name: "Divyansh Sharma",
        phone: "+919999988888",
        created_at: now,
        deleted_at: null,
        ...POISONED_PAYLOAD,
      };

      const dto = toCustomerSelfDTO(source);
      expect(dto).toEqual({
        id: "c-123",
        name: "Divyansh Sharma",
        phone: "+919999988888",
        created_at: now,
      });

      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("deleted_at");
      expect(dto).not.toHaveProperty("future_prisma_column");
    });

    it("toCustomerSummaryDTO MUST only expose id, name, and phone", () => {
      const source = {
        id: "c-123",
        name: "Divyansh Sharma",
        phone: "+919999988888",
        ...POISONED_PAYLOAD,
      };

      const dto = toCustomerSummaryDTO(source);
      expect(dto).toEqual({
        id: "c-123",
        name: "Divyansh Sharma",
        phone: "+919999988888",
      });
      expect(Object.keys(dto!).sort()).toEqual(["id", "name", "phone"].sort());
    });
  });

  describe("3. Job, Requirement, and Dispatch DTOs", () => {
    it("toJobDTO MUST recursively map customer and job_requirements via allowlists", () => {
      const now = new Date();
      const source = {
        id: "job-100",
        customer_id: "c-123",
        latitude: 19.076,
        longitude: 72.8777,
        location: "Mumbai",
        status: "OPEN",
        dispatch_status: "PENDING",
        created_at: now,
        customer: {
          id: "c-123",
          name: "Divyansh",
          phone: "+919999988888",
          ...POISONED_PAYLOAD,
        },
        job_requirement: [
          {
            id: "req-1",
            job_id: "job-100",
            skill_type: "Plumbing",
            worker_count_needed: 2,
            worker_count_filled: 1,
            rate_per_day: 500,
            status: "OPEN",
            current_wave: 1,
            wave_size: 5,
            created_at: now,
            updated_at: now,
            ...POISONED_PAYLOAD,
          },
        ],
        ...POISONED_PAYLOAD,
      };

      const dto = toJobDTO(source);
      expect(dto).toBeDefined();
      expect(dto?.id).toBe("job-100");
      expect(dto).not.toHaveProperty("future_prisma_column");
      expect(dto?.customer).not.toHaveProperty("password");
      expect(dto?.customer).not.toHaveProperty("future_prisma_column");
      expect(dto?.job_requirement?.[0]).not.toHaveProperty("future_prisma_column");
      expect(dto?.job_requirement?.[0].rate_per_day).toBe(500);
    });

    it("toDispatchDTO MUST be an explicit allowlist and NOT spread internal dispatch fields", () => {
      const now = new Date();
      const source = {
        id: "disp-1",
        requirement_id: "req-1",
        worker_id: "w-123",
        wave_number: 1,
        wave_position: 1,
        status: "pending",
        notified_at: now,
        expires_at: now,
        responded_at: null,
        created_at: now,
        updated_at: now,
        ...POISONED_PAYLOAD,
      };

      const dto = toDispatchDTO(source);
      expect(dto).toEqual({
        id: "disp-1",
        requirement_id: "req-1",
        worker_id: "w-123",
        wave_number: 1,
        wave_position: 1,
        status: "pending",
        notified_at: now,
        expires_at: now,
        responded_at: null,
        created_at: now,
        updated_at: now,
      });

      expect(dto).not.toHaveProperty("future_prisma_column");
      expect(dto).not.toHaveProperty("admin_notes");
      expect(dto).not.toHaveProperty("internal_status");
    });
  });

  describe("4. Booking DTO with Nested Relations", () => {
    it("toBookingDTO MUST strictly exclude otp_hash and recursively map worker, customer, payment, review", () => {
      const now = new Date();
      const source = {
        id: "book-1",
        job_id: "job-100",
        requirement_id: "req-1",
        worker_id: "w-123",
        customer_id: "c-123",
        status: "confirmed",
        otp_verified: false,
        created_at: now,
        updated_at: now,
        // Poisoned root
        ...POISONED_PAYLOAD,
        worker: {
          id: "w-123",
          name: "Ramesh",
          skill_type: "Plumber",
          worker_score: 5.0,
          is_online: true,
          skill_category_id: "cat-1",
          ...POISONED_PAYLOAD,
        },
        customer: {
          id: "c-123",
          name: "Divyansh",
          phone: "+919999988888",
          ...POISONED_PAYLOAD,
        },
        payment: {
          id: "pay-1",
          booking_id: "book-1",
          razorpay_order_id: "order_123",
          status: "PENDING",
          amount: 50000,
          idempotency_key: "key_123",
          ...POISONED_PAYLOAD,
        },
        review: {
          id: "rev-1",
          booking_id: "book-1",
          worker_id: "w-123",
          customer_id: "c-123",
          rating: 5,
          comment: "Great work!",
          ...POISONED_PAYLOAD,
        },
      };

      const dto = toBookingDTO(source);
      expect(dto).toBeDefined();

      // Check root properties
      expect(dto?.id).toBe("book-1");
      expect(dto).not.toHaveProperty("otp_hash");
      expect(dto).not.toHaveProperty("otp");
      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("future_prisma_column");

      // Check nested worker
      expect(dto?.worker).toBeDefined();
      expect(dto?.worker).not.toHaveProperty("password");
      expect(dto?.worker).not.toHaveProperty("device_token");
      expect(dto?.worker).not.toHaveProperty("future_prisma_column");

      // Check nested customer
      expect(dto?.customer).toBeDefined();
      expect(dto?.customer).not.toHaveProperty("password");
      expect(dto?.customer).not.toHaveProperty("future_prisma_column");

      // Check nested payment
      expect(dto?.payment).toBeDefined();
      expect(dto?.payment).not.toHaveProperty("idempotency_key");
      expect(dto?.payment).not.toHaveProperty("future_prisma_column");

      // Check nested review
      expect(dto?.review).toBeDefined();
      expect(dto?.review?.comment).toBe("Great work!");
      expect(dto?.review).not.toHaveProperty("future_prisma_column");
    });
  });

  describe("5. Chat and Skill DTOs", () => {
    it("toChatMessageDTO MUST allowlist message fields and drop conversation relations or metadata", () => {
      const now = new Date();
      const source = {
        id: "msg-1",
        conversation_id: "conv-1",
        sender_id: "w-123",
        content: "Hello customer",
        sent_at: now,
        conversation: { id: "conv-1", booking_id: "book-1" },
        ...POISONED_PAYLOAD,
      };

      const dto = toChatMessageDTO(source);
      expect(dto).toEqual({
        id: "msg-1",
        conversation_id: "conv-1",
        sender_id: "w-123",
        content: "Hello customer",
        sent_at: now,
      });

      expect(dto).not.toHaveProperty("conversation");
      expect(dto).not.toHaveProperty("future_prisma_column");
    });

    it("toSkillCategoryDTO MUST only expose id and name", () => {
      const source = {
        id: "skill-1",
        name: "Electrician",
        ...POISONED_PAYLOAD,
      };

      const dto = toSkillCategoryDTO(source);
      expect(dto).toEqual({
        id: "skill-1",
        name: "Electrician",
      });
      expect(dto).not.toHaveProperty("future_prisma_column");
    });
  });
});
