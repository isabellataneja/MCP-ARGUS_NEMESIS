/**
 * TypeScript shapes for the future `public.pairing_quality_variance` table
 * and the intermediate matrix-map / variance-pivot rows. Forward-compat
 * scaffolding — no logic in this file.
 *
 * The schema target lives in the NEMESIS repo at
 * supabase/migrations/011_pairing_quality_variance.sql (Phase 2 of the
 * Quality Variance Integration). Keep these in sync.
 *
 * See: ~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md
 */

/* -------------------------------------------------------------------------- */
/* The 11 variance flag names — frozen vocabulary from the Retool dashboard.  */
/* -------------------------------------------------------------------------- */

export const VARIANCE_FLAG_NAMES = [
  'var_note_count_shift',
  'var_sla_pct_base',
  'var_sla_pct_target',
  'var_ai_mds_f1',
  'var_ai_mds_f1_target',
  'var_ai_mds_retention',
  'var_ai_mds_retention_target',
  'var_mds_clin_retention',
  'var_mds_clin_retention_target',
  'var_avg_tat',
  'var_avg_nlf',
] as const;

export type VarianceFlagName = (typeof VARIANCE_FLAG_NAMES)[number];

/* -------------------------------------------------------------------------- */
/* The target table row shape (mirrors                                        */
/* public.pairing_quality_variance from migration 011).                       */
/* -------------------------------------------------------------------------- */

export interface PairingQualityVarianceRow {
  id?: string;
  sf_id: string;
  mds_uid: string;
  window_end_date: string;
  window_days: number;

  mds_email: string | null;
  mds_name: string | null;
  service_provider: string | null;
  mds_department: string | null;
  mds_role: string | null;
  provider_email: string | null;
  provider_full_name: string | null;
  enterprise_affiliation: string | null;
  account_name: string | null;
  customer_status: string | null;
  csm: string | null;
  scribe_partner_site: string | null;
  specialty_consolidated: string | null;
  site_sla: number | null;

  service_dates: number;
  note_count: number;
  avg_note_count_per_shift: number | null;
  avg_sla_pct: number | null;
  avg_tat: number | null;
  avg_ai_mds_f1: number | null;
  avg_ai_mds_retention: number | null;
  avg_mds_clin_retention: number | null;
  avg_nlf: number | null;

  quality_count: number;
  coverage_flag: boolean;

  var_note_count_shift: boolean;
  var_sla_pct_base: boolean;
  var_sla_pct_target: boolean;
  var_ai_mds_f1: boolean;
  var_ai_mds_f1_target: boolean;
  var_ai_mds_retention: boolean;
  var_ai_mds_retention_target: boolean;
  var_mds_clin_retention: boolean;
  var_mds_clin_retention_target: boolean;
  var_avg_tat: boolean;
  var_avg_nlf: boolean;
  total_variances: number;

  variance_details: VarianceDetails | null;

  created_at?: string;
}

/**
 * Per-flag explainability blob persisted in the `variance_details` JSONB
 * column. Lets the UI / audit show *why* a flag fired without re-running the
 * computation. Schema is intentionally open — Phase 2 finalises the shape
 * during the parity test.
 */
export interface VarianceDetails {
  flag_results: Partial<Record<VarianceFlagName, VarianceFlagResult>>;
  pair_shift_count?: number;
  note_count_dedup?: number;
}

export interface VarianceFlagResult {
  flagged: boolean;
  method: 'relative_spread' | 'sd_outlier' | 'target_gap';
  values?: number[];
  mean?: number | null;
  stdev?: number | null;
  min?: number | null;
  max?: number | null;
  threshold?: number;
}

/* -------------------------------------------------------------------------- */
/* Intermediate row shapes — the matrix-map output (Phase 2 will refine).     */
/* -------------------------------------------------------------------------- */

export interface MatrixMapRow {
  sf_id: string;
  mds_uid: string;
  mds_email: string | null;
  provider_email: string | null;
  mds_name: string | null;
  provider_full_name: string | null;
  enterprise_affiliation: string | null;
  account_name: string | null;
  customer_status: string | null;
  csm: string | null;
  scribe_partner_site: string | null;
  specialty_consolidated: string | null;
  site_sla: number | null;
  service_provider: string | null;
  mds_department: string | null;
  mds_role: string | null;
}

/**
 * One row per (visit_date, note_id) from report_go_mds_uploads.
 * Phase 2 pulls these via the BASE_ASSIST_DATA_SQL query.
 */
export interface AssistDataRow {
  clinician_uid: string;
  join_clinician_uid: string;
  join_mdsemail: string;
  visit_date: string;
  note_id: string;
  note_uploaded_from: string | null;
  clinician_send_time: string | null;
  note_first_assignment_time: string | null;
  mds_upload_time: string | null;
  recording_length_in_sec: number | null;
  batch_send_flag: string | null;
  manual_assignment_flag: string | null;
  note_block_flag: string | null;
  no_of_times_note_block: number | null;
  note_block_duration_in_hr: number | null;
}

/**
 * One row per (visit_date, sf_id, mds_uid) from
 * report_daily_clinician_mds_metrics.
 */
export interface NoteScoreRow {
  visit_date: string;
  sf_id: string;
  mds_uid: string;
  note_count: number;
  ai_mds_f1: number | null;
  ai_mds_retention: number | null;
  mds_e_prv_retention: number | null;
}

/**
 * One row per note review from report_note_reviews.
 */
export interface NoteFeedbackRow {
  sf_id: string;
  mds_uid: string;
  mds_email: string | null;
  note_id: string;
  feedback_date: string;
  visit_date: string;
  note_review_source: string;
  overall_review: number | string | null;
  specific_poor_reviews: string | null;
  text_response: string | null;
}

/**
 * One row per coverage shift from retool_db.ambient_mds_coverage_tracker.
 */
export interface CoverageRow {
  auto_id: number;
  sf_id: string | null;
  mds_uid: string | null;
  mds_name: string | null;
  coverage_reason: string | null;
  coverage_date: string;
}

/* -------------------------------------------------------------------------- */
/* Run input / output for syncQualityVariance().                              */
/* -------------------------------------------------------------------------- */

export interface QualityVarianceSyncInput {
  /** Window end (inclusive). Defaults to today UTC. */
  window_end?: Date;
  /** Window length in days. Defaults to 30 per spec. */
  window_days?: number;
  /** When true, compute + log but do NOT upsert. Useful for reconciliation. */
  dry_run?: boolean;
}

export interface QualityVarianceSyncResult {
  rows_computed: number;
  rows_upserted: number;
  window_end_date: string;
  window_days: number;
  dry_run: boolean;
  source_row_counts: {
    assist_data: number;
    matrix_maps: number;
    note_scores: number;
    note_feedback: number;
    coverage: number;
  };
}
