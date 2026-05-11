import { db } from '../supabase.js';
import {
  getContextWeight,
  getDecayWeight,
  getFeedbackSource,
  hasConsensus,
  isLearnable,
  type FeedbackLogRow,
} from './filter.js';
import { deriveCategoryFromText, isValidOverrideReasonSlug } from './reasons.js';
import { FEEDBACK_WEIGHTS } from './weights.js';

export interface FeedbackModifier {
  tat_penalty_boost: number;
  specialty_penalty_boost: number;
  escalation_penalty_boost: number;
  workload_penalty_boost: number;
  blocked_mds_ids: string[];
  good_outcome_mds_ids: string[];
  reassigned_mds_ids: string[];
  reason_tags: string[];
  feedback_source: 'direct' | 'partial' | 'global_baseline';
  feedback_count: number;
}

export function createEmptyFeedbackModifier(): FeedbackModifier {
  return {
    tat_penalty_boost: 0,
    specialty_penalty_boost: 0,
    escalation_penalty_boost: 0,
    workload_penalty_boost: 0,
    blocked_mds_ids: [],
    good_outcome_mds_ids: [],
    reassigned_mds_ids: [],
    reason_tags: [],
    feedback_source: 'global_baseline',
    feedback_count: 0,
  };
}

function normRating(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function categoryKeyForRow(entry: FeedbackLogRow): string {
  const direct = String(entry.override_reason_category ?? '').trim();
  if (direct) return direct;
  return deriveCategoryFromText(entry.override_reason) ?? '';
}

function applyDirectCategoryPenalties(
  slug: string,
  weight: number,
  mod: FeedbackModifier,
): void {
  switch (slug) {
    case 'tat_turnaround':
      mod.tat_penalty_boost += 5 * weight;
      break;
    case 'specialty_gap':
      mod.specialty_penalty_boost += 5 * weight;
      break;
    case 'ehr_workflow':
      mod.escalation_penalty_boost += 3 * weight;
      break;
    case 'workload_capacity':
    case 'availability':
      mod.workload_penalty_boost += 5 * weight;
      break;
    default:
      break;
  }
}

function legacyKeywordBoosts(
  reasonLower: string,
  weight: number,
  target: FeedbackModifier,
): void {
  if (
    reasonLower.includes('tat') ||
    reasonLower.includes('slow') ||
    reasonLower.includes('turnaround') ||
    reasonLower.includes('time')
  ) {
    target.tat_penalty_boost += 5 * weight;
  }
  if (
    reasonLower.includes('specialty') ||
    reasonLower.includes('workflow') ||
    reasonLower.includes('experience')
  ) {
    target.specialty_penalty_boost += 5 * weight;
  }
  if (
    reasonLower.includes('workload') ||
    reasonLower.includes('capacity') ||
    reasonLower.includes('availability')
  ) {
    target.workload_penalty_boost += 5 * weight;
  }
  if (
    reasonLower.includes('ehr') ||
    reasonLower.includes('escalation') ||
    reasonLower.includes('quality') ||
    reasonLower.includes('error') ||
    reasonLower.includes('mistake')
  ) {
    target.escalation_penalty_boost += 3 * weight;
  }
}

function capBoosts(mod: FeedbackModifier): void {
  mod.tat_penalty_boost = Math.min(mod.tat_penalty_boost, FEEDBACK_WEIGHTS.MAX_TAT_BOOST);
  mod.specialty_penalty_boost = Math.min(
    mod.specialty_penalty_boost,
    FEEDBACK_WEIGHTS.MAX_SPECIALTY_BOOST,
  );
  mod.escalation_penalty_boost = Math.min(
    mod.escalation_penalty_boost,
    FEEDBACK_WEIGHTS.MAX_ESCALATION_BOOST,
  );
  mod.workload_penalty_boost = Math.min(
    mod.workload_penalty_boost,
    FEEDBACK_WEIGHTS.MAX_ESCALATION_BOOST,
  );
}

function throwIfError(ctx: string, error: { message: string } | null): void {
  if (error) throw new Error(`${ctx}: ${error.message}`);
}

export async function buildFeedbackModifier(clinician_id: string): Promise<FeedbackModifier> {
  const modifier = createEmptyFeedbackModifier();

  const { data: directRaw, error: directErr } = await db
    .from('feedback_log')
    .select('*')
    .eq('clinician_id', clinician_id)
    .in('feedback_rating', ['Rejected', 'Partially Accepted'])
    .order('created_at', { ascending: false })
    .limit(FEEDBACK_WEIGHTS.MAX_FEEDBACK_LOOKBACK_DIRECT);
  throwIfError('buildFeedbackModifier.feedback_log', directErr);
  const rawDirect = (directRaw ?? []) as FeedbackLogRow[];

  const { data: phRaw, error: phErr } = await db
    .from('pairing_history')
    .select(
      'pairing_id, mds_id, clinician_id, feedback_rating, override_reason, override_reason_category, override_to_mds_id, recommendation_date, start_date',
    )
    .eq('clinician_id', clinician_id)
    .in('feedback_rating', ['Rejected', 'Partially Accepted'])
    .order('recommendation_date', { ascending: false, nullsFirst: false })
    .limit(FEEDBACK_WEIGHTS.MAX_FEEDBACK_LOOKBACK_DIRECT);
  throwIfError('buildFeedbackModifier.pairing_history', phErr);

  type PhRow = {
    mds_id?: string | number | null;
    feedback_rating?: string | null;
    override_reason?: string | null;
    override_reason_category?: string | null;
    recommendation_date?: string | null;
    start_date?: string | null;
  };
  const phNormalized: FeedbackLogRow[] = (phRaw ?? []).map((raw) => {
    const r = raw as PhRow;
    return {
      recommended_mds_id: r.mds_id == null ? null : String(r.mds_id),
      feedback_rating: r.feedback_rating ?? null,
      override_reason: r.override_reason ?? null,
      created_at: r.recommendation_date ?? r.start_date ?? null,
      override_reason_category: r.override_reason_category ?? null,
      non_data_override: false,
      clinician_name: null,
      recommended_mds_name: null,
      override_to_mds_name: null,
      flags_fired: null,
      submitted_by: null,
    };
  });

  const seen = new Set<string>(
    rawDirect.map(
      (e) => `${e.recommended_mds_id ?? ''}|${normRating(e.feedback_rating)}`,
    ),
  );
  const phUnique = phNormalized.filter((e) => {
    const k = `${e.recommended_mds_id ?? ''}|${normRating(e.feedback_rating)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const cleanFeedback = [...rawDirect, ...phUnique].filter((e) => isLearnable(e));
  modifier.feedback_count = cleanFeedback.length;
  modifier.feedback_source = getFeedbackSource(cleanFeedback.length);

  for (const entry of cleanFeedback) {
    const catKey = categoryKeyForRow(entry);
    const timeDecay = getDecayWeight(entry.created_at);
    const contextW = getContextWeight(entry);
    const consensusW = hasConsensus(cleanFeedback, catKey)
      ? 1
      : FEEDBACK_WEIGHTS.BELOW_CONSENSUS_WEIGHT;
    const weight = timeDecay * contextW * consensusW;

    if (catKey && isValidOverrideReasonSlug(catKey)) {
      applyDirectCategoryPenalties(catKey, weight, modifier);
    } else {
      legacyKeywordBoosts((entry.override_reason || '').toLowerCase(), weight, modifier);
    }

    if (entry.override_reason) {
      modifier.reason_tags.push(entry.override_reason.slice(0, 100));
    }
  }

  capBoosts(modifier);

  const rejectionCounts: Record<string, number> = {};
  for (const entry of cleanFeedback) {
    if (normRating(entry.feedback_rating) === 'Rejected' && entry.recommended_mds_id) {
      const id = String(entry.recommended_mds_id);
      rejectionCounts[id] = (rejectionCounts[id] ?? 0) + 1;
    }
  }
  modifier.blocked_mds_ids = Object.entries(rejectionCounts)
    .filter(([, count]) => count >= 2)
    .map(([id]) => id);

  const { data: outcomes, error: outErr } = await db
    .from('pairing_history')
    .select('mds_id, outcome_30d, outcome_60d, outcome_90d')
    .eq('clinician_id', clinician_id);
  throwIfError('buildFeedbackModifier.outcomes', outErr);
  for (const row of outcomes ?? []) {
    const o = row as { mds_id?: string | null; outcome_30d?: string | null; outcome_60d?: string | null };
    if (!o.mds_id) continue;
    if (o.outcome_30d === 'Reassigned' || o.outcome_60d === 'Reassigned') {
      modifier.reassigned_mds_ids.push(String(o.mds_id));
    }
    if (o.outcome_30d === 'Good' && o.outcome_60d === 'Good') {
      modifier.good_outcome_mds_ids.push(String(o.mds_id));
    }
  }
  modifier.reassigned_mds_ids = Array.from(new Set(modifier.reassigned_mds_ids));
  modifier.good_outcome_mds_ids = Array.from(new Set(modifier.good_outcome_mds_ids));

  if (
    modifier.feedback_source === 'global_baseline' ||
    modifier.feedback_source === 'partial'
  ) {
    const { data: globalRaw, error: globalErr } = await db
      .from('feedback_log')
      .select('*')
      .neq('clinician_id', clinician_id)
      .in('feedback_rating', ['Rejected', 'Partially Accepted'])
      .order('created_at', { ascending: false })
      .limit(FEEDBACK_WEIGHTS.MAX_FEEDBACK_LOOKBACK_GLOBAL);
    throwIfError('buildFeedbackModifier.global', globalErr);

    const globalWeight =
      modifier.feedback_source === 'partial'
        ? FEEDBACK_WEIGHTS.GLOBAL_BASELINE_WEIGHT / 2
        : FEEDBACK_WEIGHTS.GLOBAL_BASELINE_WEIGHT;
    const GLOBAL_PER_ROW_SCALE = 0.4;

    const globalRows = (globalRaw ?? []).filter((e) => isLearnable(e)) as FeedbackLogRow[];
    for (const entry of globalRows) {
      const w = getDecayWeight(entry.created_at) * getContextWeight(entry) * globalWeight;
      const slug =
        String(entry.override_reason_category ?? '').trim() ||
        (deriveCategoryFromText(entry.override_reason) ?? '');
      if (slug && isValidOverrideReasonSlug(slug)) {
        applyDirectCategoryPenalties(slug, w * GLOBAL_PER_ROW_SCALE, modifier);
      }
    }
    capBoosts(modifier);
  }

  modifier.reason_tags = Array.from(new Set(modifier.reason_tags));
  return modifier;
}

/**
 * Time-decayed, deduped recent override reasons. Narrative-only signal — the
 * scoring path uses `buildFeedbackModifier`; this returns the prose for an
 * LLM to ack in a justification.
 */
export async function getRecentOverrides(
  clinician_id: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await db
    .from('feedback_log')
    .select('override_reason, created_at')
    .eq('clinician_id', clinician_id)
    .in('feedback_rating', ['Rejected', 'Partially Accepted'])
    .not('override_reason', 'is', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(100, Math.max(limit * 4, 20)));
  throwIfError('getRecentOverrides', error);

  type Row = { override_reason: string | null; created_at: string | null };
  const scored = (data ?? [])
    .map((r) => r as Row)
    .filter((r) => Boolean(r.override_reason?.trim()))
    .map((r) => ({
      text: (r.override_reason as string).trim().slice(0, 280),
      weight: getDecayWeight(r.created_at),
    }))
    .sort((a, b) => b.weight - a.weight);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of scored) {
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    out.push(row.text);
    if (out.length >= limit) break;
  }
  return out;
}
