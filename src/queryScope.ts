/** Bangladesh-only scope for workforce / MDS queries (enforced at the query layer). */
export const COUNTRY_BD = 'BD' as const;

/**
 * Applies `.eq('country_code', 'BD')` to a Supabase query builder.
 */
export function scopeBangladesh<B extends { eq: (column: string, value: string) => B }>(builder: B): B {
  return builder.eq('country_code', COUNTRY_BD);
}
