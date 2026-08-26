import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLeaveBatch,
  evaluateLeaveRequestSchema,
} from "./evaluateLeave.js";
import type { SupabaseClient } from "@supabase/supabase-js";

test("evaluateLeaveRequestSchema accepts contract v1 batch", () => {
  const parsed = evaluateLeaveRequestSchema.safeParse({
    contract_version: "1",
    request_id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    coverage_datetime: "2026-09-01T13:00:00Z",
    pairings: [
      {
        pairing_id: "11111111-1111-4111-8111-111111111101",
        candidate_mds_id: "556676",
        clinician_uid: "SF-FIX-0001",
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test("evaluateLeaveBatch echoes request_id and returns every pairing", async () => {
  const supabase = createMockSupabase({
    profiles: [],
    leaveRows: [],
    predictions: [],
    dailyRecords: [],
  });

  const response = await evaluateLeaveBatch(
    supabase,
    {
      contract_version: "1",
      request_id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      coverage_datetime: "2026-09-01T13:00:00Z",
      pairings: [
        {
          pairing_id: "11111111-1111-4111-8111-111111111101",
          candidate_mds_id: "556676",
          clinician_uid: "SF-FIX-0001",
        },
        {
          pairing_id: "11111111-1111-4111-8111-111111111102",
          candidate_mds_id: "556677",
          clinician_uid: "SF-FIX-0001",
        },
      ],
    },
    "2026-09-01T13:00:02Z"
  );

  assert.equal(response.contract_version, "1");
  assert.equal(response.request_id, "6f9619ff-8b86-4d01-b42d-00cf4fc964ff");
  assert.equal(response.evaluated_at, "2026-09-01T13:00:02Z");
  assert.equal(response.results.length, 2);
  assert.deepEqual(
    response.results.map((r) => r.pairing_id).sort(),
    [
      "11111111-1111-4111-8111-111111111101",
      "11111111-1111-4111-8111-111111111102",
    ]
  );
  for (const result of response.results) {
    assert.equal(result.status, "no_data");
    assert.equal(result.leave_probability, 0);
  }
});

test("evaluateLeaveBatch returns confirmed leave >= 99.5", async () => {
  const supabase = createMockSupabase({
    profiles: [
      {
        mds_id: "wfm-123",
        mds_uid: "556676",
        mds_email: "scribe@augmedix.com",
        mds_email_alt: null,
      },
    ],
    leaveRows: [
      {
        mds_id: "wfm-123",
        employee_email: "scribe@augmedix.com",
        leave_date: "2026-09-01",
        leave_type: "Casual Leave",
        approval_status: "Approved",
      },
    ],
    predictions: [],
    dailyRecords: [{ mds_id: "wfm-123" }, { mds_id: "wfm-123" }],
  });

  const response = await evaluateLeaveBatch(supabase, {
    contract_version: "1",
    request_id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    coverage_datetime: "2026-09-01T13:00:00Z",
    pairings: [
      {
        pairing_id: "11111111-1111-4111-8111-111111111101",
        candidate_mds_id: "556676",
        clinician_uid: "SF-FIX-0001",
      },
    ],
  });

  assert.equal(response.results.length, 1);
  const result = response.results[0];
  assert.equal(result.status, "ok");
  assert.ok(result.leave_probability >= 99.5);
  assert.equal(result.evidence.leave_type, "confirmed");
  assert.equal(result.evidence.overlap, "full_day");
});

interface MockData {
  profiles: Array<Record<string, unknown>>;
  leaveRows: Array<Record<string, unknown>>;
  predictions: Array<Record<string, unknown>>;
  dailyRecords: Array<Record<string, unknown>>;
}

function createMockSupabase(data: MockData): SupabaseClient {
  return {
    from(table: string) {
      const state: { col?: string; values?: unknown[] } = {};
      const api = {
        select() {
          return api;
        },
        eq(col: string, val: unknown) {
          state.col = col;
          state.values = [val];
          return api;
        },
        gte() {
          return api;
        },
        lte() {
          return api;
        },
        in(col: string, values: unknown[]) {
          state.col = col;
          state.values = values;
          return api;
        },
        then(onFulfilled: (value: unknown) => unknown) {
          if (table === "mds_profile_info" && state.col === "mds_uid") {
            const wanted = new Set((state.values ?? []).map(String));
            return Promise.resolve({
              data: data.profiles.filter((row) =>
                wanted.has(String(row.mds_uid))
              ),
              error: null,
            }).then(onFulfilled);
          }
          if (table === "argus_live_state" && state.col === "mds_email") {
            return Promise.resolve({ data: [], error: null }).then(onFulfilled);
          }
          if (table === "argus_leave_entries" && state.col === "mds_id") {
            const wanted = new Set((state.values ?? []).map(String));
            return Promise.resolve({
              data: data.leaveRows.filter((row) =>
                wanted.has(String(row.mds_id))
              ),
              error: null,
            }).then(onFulfilled);
          }
          if (table === "argus_leave_entries" && state.col === "employee_email") {
            const wanted = new Set(
              (state.values as string[]).map((v) => v.toLowerCase())
            );
            return Promise.resolve({
              data: data.leaveRows.filter((row) =>
                wanted.has(String(row.employee_email).toLowerCase())
              ),
              error: null,
            }).then(onFulfilled);
          }
          if (table === "mds_daily_prediction" && state.col === "mds_id") {
            const wanted = new Set((state.values ?? []).map(String));
            return Promise.resolve({
              data: data.predictions.filter((row) =>
                wanted.has(String(row.mds_id))
              ),
              error: null,
            }).then(onFulfilled);
          }
          if (table === "mds_daily_record" && state.col === "mds_id") {
            const wanted = new Set((state.values ?? []).map(String));
            return Promise.resolve({
              data: data.dailyRecords.filter((row) =>
                wanted.has(String(row.mds_id))
              ),
              error: null,
            }).then(onFulfilled);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled);
        },
      };
      return api;
    },
  } as unknown as SupabaseClient;
}
