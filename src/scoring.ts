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
};

export type RankedMds = {
  mds_id: string;
  mds_name: string | null;
  score: number;
  components: ScoreComponents;
  flags: string[];
  availability_confirmed?: boolean;
};

function num(v: number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined || Number.isNaN(v)) return fallback;
  return v;
}

function ilikeMatch(hay: string | null | undefined, needle: string | null | undefined): boolean {
  if (!hay || !needle) return false;
  return hay.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Shared NEMESIS-style score (0–1-ish composite). Used by `rank_mds_candidates` and `find_backup_candidates`.
 */
export function scoreMdsForClinician(mds: MdsCandidateShape, clinician: ClinicianShape): { score: number; components: ScoreComponents; flags: string[] } {
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

  let score =
    wSla * sla + wRet * retention + wRev * reviews + wSpec * specMatch + wEhr * ehrMatch - penalties;
  score = Math.max(0, Math.min(1.5, score));

  return {
    score,
    components: {
      sla: wSla * sla,
      retention: wRet * retention,
      reviews: wRev * reviews,
      specialty: wSpec * specMatch,
      ehr: wEhr * ehrMatch,
      penalties,
    },
    flags,
  };
}

export const ACTIVE_EMPLOYMENT = ['active', 'Active', 'ACTIVE', 'probation', 'Probation'] as const;

export function isActiveEmployment(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  if (s === 'active' || s === 'probation') return true;
  return (ACTIVE_EMPLOYMENT as readonly string[]).includes(status);
}
