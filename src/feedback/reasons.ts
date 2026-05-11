export const PRIMARY_OVERRIDE_REASONS = [
  { slug: 'tat_turnaround', label: 'TAT / turnaround time concern' },
  { slug: 'ehr_workflow', label: 'EHR workflow mismatch' },
  { slug: 'specialty_gap', label: 'Specialty or clinical gap' },
  { slug: 'workload_capacity', label: 'Workload or capacity concern' },
  { slug: 'availability', label: 'Availability issue' },
  { slug: 'manager_preference', label: 'Manager or team preference' },
  { slug: 'data_incorrect', label: 'Data appears incorrect' },
  { slug: 'other', label: 'Other' },
] as const;

export type OverrideReasonSlug = (typeof PRIMARY_OVERRIDE_REASONS)[number]['slug'];

const SLUG_SET = new Set<string>(PRIMARY_OVERRIDE_REASONS.map((r) => r.slug));

export function isValidOverrideReasonSlug(s: unknown): s is OverrideReasonSlug {
  return typeof s === 'string' && SLUG_SET.has(s);
}

/**
 * Mirrors NEMESIS-side `deriveCategoryFromText`. Two-layer: canonical-label
 * prefix match, then keyword heuristic. Returns null when neither fires —
 * caller treats null as "uncategorized" and falls back to keyword penalties.
 */
export function deriveCategoryFromText(
  text: string | null | undefined,
): OverrideReasonSlug | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  for (const r of PRIMARY_OVERRIDE_REASONS) {
    if (
      t === r.label ||
      t.startsWith(`${r.label}:`) ||
      t.startsWith(`${r.label} -`) ||
      t.startsWith(`${r.label} —`)
    ) {
      return r.slug;
    }
  }

  const lc = t.toLowerCase();

  if (
    /\btat\b/.test(lc) ||
    lc.includes('turnaround') ||
    lc.includes('turn-around') ||
    lc.includes('slow note') ||
    lc.includes('slow notes') ||
    lc.includes('late notes')
  ) {
    return 'tat_turnaround';
  }

  if (
    lc.includes('ehr') ||
    lc.includes('epic') ||
    lc.includes('cerner') ||
    lc.includes('meditech') ||
    lc.includes('athena') ||
    lc.includes('nextgen') ||
    lc.includes('eclinicalworks') ||
    lc.includes('workflow')
  ) {
    return 'ehr_workflow';
  }

  if (
    lc.includes('specialty') ||
    lc.includes('clinical gap') ||
    lc.includes('subspecialty') ||
    lc.includes('oncology') ||
    lc.includes('cardiology') ||
    lc.includes('orthopedics') ||
    lc.includes('dermatology')
  ) {
    return 'specialty_gap';
  }

  if (
    lc.includes('workload') ||
    lc.includes('capacity') ||
    lc.includes('overloaded') ||
    lc.includes('too many') ||
    lc.includes('note volume')
  ) {
    return 'workload_capacity';
  }

  if (
    lc.includes('resigned') ||
    lc.includes('resignation') ||
    lc.includes('unavailable') ||
    lc.includes('on leave') ||
    lc.includes('off shift') ||
    lc.includes('not available') ||
    lc.includes('availability')
  ) {
    return 'availability';
  }

  if (
    lc.includes('manager') ||
    lc.includes('team preference') ||
    lc.includes('preferred mds') ||
    lc.includes('preference of')
  ) {
    return 'manager_preference';
  }

  if (
    lc.includes('data') ||
    lc.includes('incorrect') ||
    lc.includes('wrong info') ||
    lc.includes('mismatch')
  ) {
    return 'data_incorrect';
  }

  return null;
}
