import type { FeedbackModifier } from './feedback/modifier.js';
import type { Region } from './filters.js';

export type ClinicianShape = {
  specialty: string | null;
  ehr_system: string | null;
};

export type MdsCandidateShape = {
  mds_id: string;
  mds_name: string | null;
  specialty_experience: string | null;
  active_ehrs: string | null;
  sla_met_pct: number | null;
  ai_mds_retention_pct: number | null;
  avg_overall_review: number | null;
  hot_list: boolean | null;
  open_escalations: number | null;
  open_remediation_p1_p2: boolean | null;
  active_p3_remediation: boolean | null;
};

export type ScoreComponents = {
  sla: number;
  retention: number;
  reviews: number;
  specialty: number;
  ehr: number;
  penalties: number;
  feedback?: number;
  bonuses?: number;
};

export type RankedMds = {
  mds_id: string;
  mds_name: string | null;
  score: number;
  components: ScoreComponents;
  flags: string[];
  availability_confirmed?: boolean;
  capped?: boolean;
  cap_reason?: string | null;
};

function num(v: number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined || Number.isNaN(v)) return fallback;
  return v;
}

function ilikeMatch(hay: string | null | undefined, needle: string | null | undefined): boolean {
  if (!hay || !needle) return false;
  return hay.toLowerCase().includes(needle.toLowerCase());
}

const MULTI_REJECTION_FLAG = 'Rejected multiple times for this clinician — review carefully';
const OUTCOME_REASSIGNED_FLAG = 'Reassigned previously — requires ops review before re-assigning';

/**
 * Shared NEMESIS-style score (0–1-ish composite). Used by `rank_mds_candidates` and `find_backup_candidates`.
 *
 * When `modifier` is supplied, applies feedback-aware adjustments mirroring the
 * NEMESIS-side `calculateScore`: per-category penalty boosts, proven-pairing
 * bonus, reassignment / blocked score caps. Penalty boosts are stored in 100-unit
 * NEMESIS form; converted to MCP's 0–1.5 scale by dividing by 100.
 */
export function scoreMdsForClinician(
  mds: MdsCandidateShape,
  clinician: ClinicianShape,
  _region?: Region,
  modifier?: FeedbackModifier,
): {
  score: number;
  components: ScoreComponents;
  flags: string[];
  capped: boolean;
  cap_reason: string | null;
} {
  void _region;
  const flags: string[] = [];
  const wSla = 0.3;
  const wRet = 0.2;
  const wRev = 0.2;
  const wSpec = 0.2;
  const wEhr = 0.1;

  const sla = num(mds.sla_met_pct, 0) / 100;
  const retention = num(mds.ai_mds_retention_pct, 0) / 100;
  const reviews = num(mds.avg_overall_review, 0) / 5;

  const specMatch = ilikeMatch(mds.specialty_experience, clinician.specialty) ? 1 : 0;
  const ehrMatch = ilikeMatch(mds.active_ehrs, clinician.ehr_system) ? 1 : 0;

  let penalties = 0;
  if (mds.hot_list) {
    penalties += 0.1;
    flags.push('hot_list');
  }
  const esc = num(mds.open_escalations, 0);
  if (esc > 0) {
    penalties += 0.05 * esc;
    flags.push('open_escalations');
  }
  if (mds.open_remediation_p1_p2) {
    penalties += 0.15;
    flags.push('p1_p2_remediation');
  }
  if (mds.active_p3_remediation) {
    penalties += 0.1;
    flags.push('p3_remediation');
  }

  let feedbackPenalty = 0;
  let bonuses = 0;
  let capped = false;
  let cap_reason: string | null = null;

  if (modifier) {
    // Convert NEMESIS-side 100-unit boosts to MCP's 0–1.5 scale.
    const slaPct = num(mds.sla_met_pct, 0);
    const poorSla = slaPct > 0 && slaPct < 90;

    if (poorSla && modifier.tat_penalty_boost > 0) {
      feedbackPenalty += modifier.tat_penalty_boost / 100;
    }
    if (modifier.specialty_penalty_boost > 0) {
      feedbackPenalty += modifier.specialty_penalty_boost / 100;
    }
    if (modifier.workload_penalty_boost > 0) {
      feedbackPenalty += modifier.workload_penalty_boost / 100;
    }
    if (esc > 0 && modifier.escalation_penalty_boost > 0) {
      feedbackPenalty += modifier.escalation_penalty_boost / 100;
    }

    if (modifier.good_outcome_mds_ids.includes(mds.mds_id)) {
      bonuses += 12 / 100;
      flags.push('proven_pairing');
    }

    if (modifier.reassigned_mds_ids.includes(mds.mds_id)) {
      feedbackPenalty += 10 / 100;
      flags.push(OUTCOME_REASSIGNED_FLAG);
    }
  }

  let score =
    wSla * sla +
    wRet * retention +
    wRev * reviews +
    wSpec * specMatch +
    wEhr * ehrMatch -
    penalties -
    feedbackPenalty +
    bonuses;
  score = Math.max(0, Math.min(1.5, score));

  if (modifier?.reassigned_mds_ids.includes(mds.mds_id)) {
    const cap = 40 / 100;
    if (score > cap) {
      score = cap;
      capped = true;
      cap_reason = 'Previously reassigned for this clinician within 60 days (outcome signal)';
    }
  }
  if (modifier?.blocked_mds_ids.includes(mds.mds_id)) {
    const cap = 60 / 100;
    if (score > cap) {
      score = cap;
      capped = true;
      cap_reason =
        cap_reason ?? 'Rejected multiple times for this clinician (feedback learning)';
    }
    if (!flags.includes(MULTI_REJECTION_FLAG)) flags.push(MULTI_REJECTION_FLAG);
  }

  return {
    score,
    components: {
      sla: wSla * sla,
      retention: wRet * retention,
      reviews: wRev * reviews,
      specialty: wSpec * specMatch,
      ehr: wEhr * ehrMatch,
      penalties,
      feedback: feedbackPenalty,
      bonuses,
    },
    flags,
    capped,
    cap_reason,
  };
}

export const ACTIVE_EMPLOYMENT = ['active', 'Active', 'ACTIVE', 'probation', 'Probation'] as const;

export function isActiveEmployment(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  if (s === 'active' || s === 'probation') return true;
  return (ACTIVE_EMPLOYMENT as readonly string[]).includes(status);
}
