import { FEEDBACK_WEIGHTS } from './weights.js';

export interface FeedbackLogRow {
  recommended_mds_id: string | null;
  feedback_rating: string | null;
  override_reason: string | null;
  created_at?: string | null;
  clinician_name?: string | null;
  recommended_mds_name?: string | null;
  override_to_mds_name?: string | null;
  flags_fired?: string | null;
  override_reason_category?: string | null;
  submitted_by?: string | null;
  non_data_override?: boolean | null;
}

const TEST_PATTERN = /test/i;

function fieldAsString(field: unknown): string | null {
  if (field == null) return null;
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) return field.join(' ');
  return String(field);
}

export function isTestFeedback(entry: unknown): boolean {
  if (entry == null || typeof entry !== 'object') return false;
  const o = entry as Record<string, unknown>;
  const fields = [
    o.override_reason,
    o.override_reason_category,
    o.clinician_name,
    o.recommended_mds_name,
    o.override_to_mds_name,
    o.flags_fired,
  ];
  return fields.some((f) => {
    const s = fieldAsString(f);
    return Boolean(s && TEST_PATTERN.test(s));
  });
}

export function isLearnable(entry: unknown): boolean {
  if (isTestFeedback(entry)) return false;
  if (entry == null || typeof entry !== 'object') return false;
  return true;
}

export function getContextWeight(entry: unknown): number {
  if (entry == null || typeof entry !== 'object') return 1;
  const o = entry as Record<string, unknown>;
  if (o.non_data_override === true) {
    return FEEDBACK_WEIGHTS.NON_DATA_OVERRIDE_WEIGHT;
  }
  return 1;
}

export function getDecayWeight(createdAt: string | null | undefined): number {
  if (!createdAt || !String(createdAt).trim()) return 0.5;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0.5;
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days < 0) return 1;
  return Math.pow(
    FEEDBACK_WEIGHTS.PENALTY_DECAY_HALF_LIFE,
    days / FEEDBACK_WEIGHTS.HALF_LIFE_DAYS,
  );
}

export function hasConsensus(entries: unknown[], category: string): boolean {
  const matching = entries.filter((e) => {
    if (!isLearnable(e)) return false;
    const o = e as Record<string, unknown>;
    const cat = String(o.override_reason_category ?? '').trim();
    return cat === category;
  });
  const uniqueUsers = new Set(
    matching.map(
      (e) =>
        String((e as Record<string, unknown>).submitted_by ?? '').trim() || 'unknown',
    ),
  );
  return (
    uniqueUsers.size >= FEEDBACK_WEIGHTS.MIN_USERS_FOR_SIGNAL ||
    matching.length >= FEEDBACK_WEIGHTS.MIN_SAME_USER_REPEATS
  );
}

export function getFeedbackSource(
  directCount: number,
): 'direct' | 'partial' | 'global_baseline' {
  if (directCount >= FEEDBACK_WEIGHTS.MIN_DIRECT_FEEDBACK_FOR_FULL_WEIGHT) {
    return 'direct';
  }
  if (directCount > 0) return 'partial';
  return 'global_baseline';
}
