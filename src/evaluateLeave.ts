import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ARGUS_CONTRACT_VERSION = "1" as const;

const pairingSchema = z.object({
  pairing_id: z.uuid(),
  candidate_mds_id: z.string().min(1),
  clinician_uid: z.string().min(1),
});

export const evaluateLeaveRequestSchema = z.object({
  contract_version: z.literal(ARGUS_CONTRACT_VERSION),
  request_id: z.uuid(),
  coverage_datetime: z.string().min(1),
  pairings: z.array(pairingSchema).min(1).max(10),
});

export type EvaluateLeaveRequest = z.infer<typeof evaluateLeaveRequestSchema>;

type LeaveEvidenceType = "confirmed" | "requested" | "predicted" | "none";
type LeaveOverlap = "full_day" | "partial" | "none";
type LeaveConfidence = "high" | "medium" | "low";

export interface EvaluateLeaveResult {
  pairing_id: string;
  leave_probability: number;
  confidence: LeaveConfidence;
  status: "ok" | "no_data";
  reasoning: string;
  evidence: {
    leave_type: LeaveEvidenceType;
    overlap: LeaveOverlap;
    source_rows: number;
  };
}

export interface EvaluateLeaveResponse {
  contract_version: typeof ARGUS_CONTRACT_VERSION;
  request_id: string;
  evaluated_at: string;
  results: EvaluateLeaveResult[];
}

interface ProfileRow {
  mds_id: string | null;
  mds_uid: string | null;
  mds_email: string | null;
  mds_email_alt: string | null;
}

interface LiveStateRow {
  mds_email: string | null;
  wfm_id: string | null;
  scribe_unique_id: string | null;
  assist_mds_uid: string | null;
}

interface LeaveRow {
  mds_id: string | null;
  employee_email: string | null;
  leave_date: string;
  leave_type: string | null;
  approval_status: string | null;
}

interface PredictionRow {
  mds_id: string;
  presence_prediction: string;
  presence_probability: number | null;
  presence_confidence: string | null;
}

interface DailyRecordCountRow {
  mds_id: string;
}

const LOOKBACK_DAYS = 30;

function coverageDateFromIso(iso: string): string {
  const slice = iso.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(slice)) return slice;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid coverage_datetime: ${iso}`);
  }
  return parsed.toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((v) => (v != null ? String(v).trim() : ""))
        .filter((v) => v.length > 0)
    )
  );
}

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.endsWith("@commure.com")) {
    return trimmed.replace("@commure.com", "@augmedix.com");
  }
  return trimmed;
}

function profileEmails(profile: ProfileRow | undefined): string[] {
  if (!profile) return [];
  const emails: string[] = [];
  for (const raw of [profile.mds_email, profile.mds_email_alt]) {
    if (!raw) continue;
    emails.push(raw.trim().toLowerCase());
    emails.push(normalizeEmail(raw));
  }
  return uniqueStrings(emails);
}

function isApprovedLeave(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  if (!s) return false;
  if (
    s.includes("reject") ||
    s.includes("cancel") ||
    s.includes("denied") ||
    s.includes("withdraw")
  ) {
    return false;
  }
  return s.includes("approved") || s.includes("confirm");
}

function isPendingLeave(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  if (!s) return true;
  if (
    s.includes("reject") ||
    s.includes("cancel") ||
    s.includes("denied") ||
    s.includes("withdraw")
  ) {
    return false;
  }
  if (isApprovedLeave(s)) return false;
  return (
    s.includes("pending") ||
    s.includes("request") ||
    s.includes("submitted") ||
    s.includes("await")
  );
}

function inferOverlap(leaveType: string | null | undefined): LeaveOverlap {
  const s = String(leaveType ?? "").toLowerCase();
  if (s.includes("half") || s.includes("partial") || s.includes("short")) {
    return "partial";
  }
  return "full_day";
}

function roundProbability(value: number): number {
  return Math.round(value * 10) / 10;
}

function mapPredictionConfidence(raw: string | null | undefined): LeaveConfidence {
  const s = String(raw ?? "").toLowerCase();
  if (s === "high") return "high";
  if (s === "medium" || s === "medium-high") return "medium";
  return "low";
}

function pickBestLeave(rows: LeaveRow[]): LeaveRow | null {
  if (rows.length === 0) return null;
  const approved = rows.filter((r) => isApprovedLeave(r.approval_status));
  if (approved.length > 0) return approved[0];
  const pending = rows.filter((r) => isPendingLeave(r.approval_status));
  if (pending.length > 0) return pending[0];
  return rows[0];
}

function evaluatePairing(input: {
  pairing_id: string;
  profile: ProfileRow | undefined;
  idVariants: string[];
  emails: string[];
  coverageLeave: LeaveRow[];
  historyLeaveCount: number;
  dailyRecordCount: number;
  prediction: PredictionRow | undefined;
}): EvaluateLeaveResult {
  const sourceRows = input.historyLeaveCount + input.dailyRecordCount;
  const hasProfile = Boolean(input.profile);
  const hasAnyData = hasProfile || sourceRows > 0 || Boolean(input.prediction);

  if (!hasAnyData) {
    return {
      pairing_id: input.pairing_id,
      leave_probability: 0,
      confidence: "low",
      status: "no_data",
      reasoning: "No attendance or leave records available for this MDS.",
      evidence: { leave_type: "none", overlap: "none", source_rows: 0 },
    };
  }

  const leaveToday = pickBestLeave(input.coverageLeave);
  if (leaveToday) {
    const overlap = inferOverlap(leaveToday.leave_type);
    if (isApprovedLeave(leaveToday.approval_status)) {
      return {
        pairing_id: input.pairing_id,
        leave_probability: 99.5,
        confidence: "high",
        status: "ok",
        reasoning: "Approved full-day leave on file for the coverage date.",
        evidence: {
          leave_type: "confirmed",
          overlap,
          source_rows: sourceRows,
        },
      };
    }
    if (isPendingLeave(leaveToday.approval_status)) {
      const fullDay = overlap === "full_day";
      return {
        pairing_id: input.pairing_id,
        leave_probability: roundProbability(fullDay ? 63 : 45),
        confidence: fullDay ? "medium" : "low",
        status: "ok",
        reasoning: fullDay
          ? "Requested (not yet approved) leave covering the full coverage window."
          : "Pending leave request overlaps part of the coverage window.",
        evidence: {
          leave_type: "requested",
          overlap,
          source_rows: sourceRows,
        },
      };
    }
  }

  const prediction = input.prediction;
  if (
    prediction &&
    prediction.presence_prediction === "likely_out" &&
    prediction.presence_probability != null
  ) {
    const prob = roundProbability(
      Math.min(85, Math.max(15, prediction.presence_probability * 100))
    );
    return {
      pairing_id: input.pairing_id,
      leave_probability: prob,
      confidence: mapPredictionConfidence(prediction.presence_confidence),
      status: "ok",
      reasoning:
        input.historyLeaveCount > 0
          ? "One leave day in the past month; model predicts likely absence for the coverage date."
          : "Model predicts likely absence for the coverage date based on recent patterns.",
      evidence: {
        leave_type: "predicted",
        overlap: "none",
        source_rows: sourceRows,
      },
    };
  }

  if (input.historyLeaveCount > 0) {
    const prob = roundProbability(Math.min(30, 8 + input.historyLeaveCount * 4));
    return {
      pairing_id: input.pairing_id,
      leave_probability: prob,
      confidence: "medium",
      status: "ok",
      reasoning:
        "One leave day in the past month; nothing scheduled for the coverage date.",
      evidence: {
        leave_type: "predicted",
        overlap: "none",
        source_rows: sourceRows,
      },
    };
  }

  const lowProb = sourceRows >= 6 ? 2.5 : 7;
  return {
    pairing_id: input.pairing_id,
    leave_probability: roundProbability(lowProb),
    confidence: sourceRows >= 4 ? "high" : "medium",
    status: "ok",
    reasoning:
      sourceRows >= 4
        ? "No leave on file for this date and no recent leave pattern."
        : "No leave on file; limited historical attendance data available.",
    evidence: { leave_type: "none", overlap: "none", source_rows: sourceRows },
  };
}

async function fetchProfilesByUid(
  supabase: SupabaseClient,
  uids: string[]
): Promise<Map<string, ProfileRow>> {
  const map = new Map<string, ProfileRow>();
  if (uids.length === 0) return map;

  const { data, error } = await supabase
    .from("mds_profile_info")
    .select("mds_id, mds_uid, mds_email, mds_email_alt")
    .in("mds_uid", uids);

  if (error) throw new Error(`mds_profile_info lookup failed: ${error.message}`);

  for (const raw of data ?? []) {
    const row = raw as ProfileRow;
    if (row.mds_uid) map.set(String(row.mds_uid).trim(), row);
  }
  return map;
}

async function fetchLiveStateByEmail(
  supabase: SupabaseClient,
  emails: string[]
): Promise<Map<string, LiveStateRow>> {
  const map = new Map<string, LiveStateRow>();
  if (emails.length === 0) return map;

  const { data, error } = await supabase
    .from("argus_live_state")
    .select("mds_email, wfm_id, scribe_unique_id, assist_mds_uid")
    .in(
      "mds_email",
      emails.map((e) => e.toLowerCase())
    );

  if (error) {
    console.warn("[evaluateLeave] argus_live_state lookup:", error.message);
    return map;
  }

  for (const raw of data ?? []) {
    const row = raw as LiveStateRow;
    if (row.mds_email) map.set(row.mds_email.toLowerCase(), row);
  }
  return map;
}

async function fetchLeaveRows(
  supabase: SupabaseClient,
  ids: string[],
  emails: string[],
  fromDate: string,
  toDate: string
): Promise<LeaveRow[]> {
  const merged: LeaveRow[] = [];
  const seen = new Set<string>();

  async function mergeQuery(
    query: PromiseLike<{ data: LeaveRow[] | null; error: { message: string } | null }>
  ): Promise<void> {
    const { data, error } = await query;
    if (error) {
      console.warn("[evaluateLeave] argus_leave_entries:", error.message);
      return;
    }
    for (const row of data ?? []) {
      const key = `${row.mds_id ?? ""}|${row.employee_email ?? ""}|${row.leave_date}|${row.leave_type ?? ""}|${row.approval_status ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }

  if (ids.length > 0) {
    await mergeQuery(
      supabase
        .from("argus_leave_entries")
        .select("mds_id, employee_email, leave_date, leave_type, approval_status")
        .in("mds_id", ids)
        .gte("leave_date", fromDate)
        .lte("leave_date", toDate)
    );
  }

  if (emails.length > 0) {
    await mergeQuery(
      supabase
        .from("argus_leave_entries")
        .select("mds_id, employee_email, leave_date, leave_type, approval_status")
        .in(
          "employee_email",
          emails.map((e) => e.toLowerCase())
        )
        .gte("leave_date", fromDate)
        .lte("leave_date", toDate)
    );
  }

  return merged;
}

async function fetchPredictions(
  supabase: SupabaseClient,
  ids: string[],
  coverageDate: string
): Promise<Map<string, PredictionRow>> {
  const map = new Map<string, PredictionRow>();
  if (ids.length === 0) return map;

  const { data, error } = await supabase
    .from("mds_daily_prediction")
    .select("mds_id, presence_prediction, presence_probability, presence_confidence")
    .eq("prediction_date", coverageDate)
    .in("mds_id", ids);

  if (error) {
    console.warn("[evaluateLeave] mds_daily_prediction:", error.message);
    return map;
  }

  for (const raw of data ?? []) {
    const row = raw as PredictionRow;
    map.set(String(row.mds_id).trim(), row);
  }
  return map;
}

async function fetchDailyRecordCounts(
  supabase: SupabaseClient,
  ids: string[],
  fromDate: string,
  toDate: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;

  const { data, error } = await supabase
    .from("mds_daily_record")
    .select("mds_id")
    .in("mds_id", ids)
    .gte("date", fromDate)
    .lte("date", toDate);

  if (error) {
    console.warn("[evaluateLeave] mds_daily_record:", error.message);
    return counts;
  }

  for (const raw of data ?? []) {
    const row = raw as DailyRecordCountRow;
    const id = String(row.mds_id).trim();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function rowMatchesCandidate(
  row: LeaveRow,
  ids: Set<string>,
  emails: Set<string>
): boolean {
  const rowId = row.mds_id != null ? String(row.mds_id).trim() : "";
  if (rowId && ids.has(rowId)) return true;
  const rowEmail = row.employee_email != null ? normalizeEmail(row.employee_email) : "";
  if (rowEmail && emails.has(rowEmail)) return true;
  return false;
}

function firstMatchingPrediction(
  predictions: Map<string, PredictionRow>,
  ids: string[]
): PredictionRow | undefined {
  for (const id of ids) {
    const hit = predictions.get(id);
    if (hit) return hit;
  }
  return undefined;
}

function sumDailyRecordCounts(
  counts: Map<string, number>,
  ids: string[]
): number {
  let total = 0;
  for (const id of ids) {
    total += counts.get(id) ?? 0;
  }
  return total;
}

export async function evaluateLeaveBatch(
  supabase: SupabaseClient,
  request: EvaluateLeaveRequest,
  evaluatedAt: string = new Date().toISOString()
): Promise<EvaluateLeaveResponse> {
  const coverageDate = coverageDateFromIso(request.coverage_datetime);
  const lookbackStart = addDaysYmd(coverageDate, -LOOKBACK_DAYS);

  const uids = uniqueStrings(request.pairings.map((p) => p.candidate_mds_id));
  const profilesByUid = await fetchProfilesByUid(supabase, uids);

  const resolved = request.pairings.map((pairing) => {
    const profile = profilesByUid.get(pairing.candidate_mds_id.trim());
    const emails = profileEmails(profile);
    const idVariants = uniqueStrings([
      profile?.mds_id,
      pairing.candidate_mds_id,
    ]);
    return {
      pairing_id: pairing.pairing_id,
      candidate_mds_id: pairing.candidate_mds_id,
      profile,
      emails,
      idVariants,
    };
  });

  const allEmails = uniqueStrings(resolved.flatMap((r) => r.emails));
  const liveByEmail = await fetchLiveStateByEmail(supabase, allEmails);

  for (const item of resolved) {
    for (const email of item.emails) {
      const live = liveByEmail.get(email.toLowerCase());
      if (!live) continue;
      item.idVariants.push(
        ...uniqueStrings([
          live.wfm_id,
          live.scribe_unique_id,
          live.assist_mds_uid,
        ])
      );
    }
    item.idVariants = uniqueStrings(item.idVariants);
  }

  const allIds = uniqueStrings(resolved.flatMap((r) => r.idVariants));

  const [leaveRows, predictions, dailyCounts] = await Promise.all([
    fetchLeaveRows(supabase, allIds, allEmails, lookbackStart, coverageDate),
    fetchPredictions(supabase, allIds, coverageDate),
    fetchDailyRecordCounts(supabase, allIds, lookbackStart, coverageDate),
  ]);

  const results = resolved.map((item) => {
    const idSet = new Set(item.idVariants);
    const emailSet = new Set(item.emails.map((e) => normalizeEmail(e)));

    const candidateLeaves = leaveRows.filter((row) =>
      rowMatchesCandidate(row, idSet, emailSet)
    );
    const coverageLeave = candidateLeaves.filter(
      (row) => String(row.leave_date).slice(0, 10) === coverageDate
    );
    const historyLeaveCount = candidateLeaves.filter(
      (row) => String(row.leave_date).slice(0, 10) !== coverageDate
    ).length;

    return evaluatePairing({
      pairing_id: item.pairing_id,
      profile: item.profile,
      idVariants: item.idVariants,
      emails: item.emails,
      coverageLeave,
      historyLeaveCount,
      dailyRecordCount: sumDailyRecordCounts(dailyCounts, item.idVariants),
      prediction: firstMatchingPrediction(predictions, item.idVariants),
    });
  });

  return {
    contract_version: ARGUS_CONTRACT_VERSION,
    request_id: request.request_id,
    evaluated_at: evaluatedAt,
    results,
  };
}
