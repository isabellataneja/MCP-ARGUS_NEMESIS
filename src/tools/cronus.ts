import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { asMcpTextContent, instrumented } from '../instrument.js';
import { normandyDb } from '../normandyDb.js';

/**
 * CRONUS note-cache tools — §10 `cronus_getUpdatedNotes` and §11
 * `cronus_getNoteContentBulk` from MCP_TOOLS_TO_ADD.md in the Cronus repo
 * (that doc is the contract; do not change shapes here without amending it).
 *
 * Source database: `normandy` (read-only, see src/normandyDb.ts). The canonical
 * note identity is COALESCE(additional_context->'more_info'->>'note_id',
 * scribe.id::text) — the normandy-side equivalent of the warehouse's
 * COALESCE(el_note_id, noteid)::text that reference/sql/rlGetNotesByClinDate.sql
 * uses, and the exact predicate reference/sql/rlGetNoteContent.sql resolves a
 * note_id with.
 *
 * `clinician_sf_id` and `date_of_service` in §10 output are always null in v1:
 * they live in the ax_ai_augbidw warehouse (MSSQL), which this server has no
 * connection to. The spec marks both nullable; the cache stores them nullable.
 *
 * PHI: §10 responses carry no note text. §11 responses do; NEVER log arguments
 * or results here — log tool name, counts, and latency only (`instrumented`
 * records input *shapes*, not values).
 */

// --- shared identity fragments ----------------------------------------------

const EXTRACTED_NOTE_ID = "s.additional_context -> 'more_info' ->> 'note_id'";

// --- §10 cronus_getUpdatedNotes ---------------------------------------------

const getUpdatedNotesInput = z.object({
  since_ts: z.string().datetime({ offset: true }),
  until_ts: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  page_size: z.number().int().min(1).max(500).optional(),
});

export type GetUpdatedNotesInput = z.infer<typeof getUpdatedNotesInput>;

export interface UpdatedNoteCopy {
  copy_type: 'transcript' | 'ai_copy' | 'mds_copy' | 'ehr_copy' | 'signed_copy';
  object_version: string | null;
  source_created_at: string | null;
  source_edited_at: string | null;
}

export interface UpdatedNote {
  note_id: string;
  scribe_id: string | null;
  augx_note_id: string | null;
  appointment_id: string | null;
  scribe_account_id: string | null;
  clinician_sf_id: string | null;
  date_of_service: string | null;
  last_activity_at: string;
  copies: UpdatedNoteCopy[];
}

export interface GetUpdatedNotesResult {
  notes: UpdatedNote[];
  next_cursor: string | null;
}

interface Cursor {
  t: string; // last_activity_at ISO
  s: string; // scribe_id::text
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cronus_getUpdatedNotes: malformed cursor');
  }
  const c = parsed as Partial<Cursor>;
  if (typeof c.t !== 'string' || typeof c.s !== 'string' || Number.isNaN(Date.parse(c.t))) {
    throw new Error('cronus_getUpdatedNotes: malformed cursor');
  }
  return { t: c.t, s: c.s };
}

/**
 * Change index. Phase 1 (`changed`/`page`) finds scribes with any tracked
 * activity in [since, until) and keyset-pages them ascending by
 * (last_activity_at, scribe_id::text). Phase 2 computes identity + per-copy
 * version facts for ONLY the paged scribes (≤ page_size rows), using the same
 * ranked rn=1 selection rlGetNoteContent.sql uses. No note content anywhere.
 *
 * "Updated" semantics per the spec: scribe.created_at, transcriptions.created_at,
 * augx_notebuilder_notes.created_at/edited_date (3 tracked note_types),
 * augx_note_version_history.created_at (3 tracked version_names),
 * scribe_signed_notes.created_at.
 */
const UPDATED_NOTES_SQL = `
WITH changed AS (
  SELECT ev.scribe_id, MAX(ev.ts) AS last_activity_at
  FROM (
    SELECT s.id AS scribe_id, s.created_at AS ts
    FROM scribe s
    WHERE s.created_at >= $1 AND s.created_at < $2

    UNION ALL
    SELECT s.id, t.created_at
    FROM scribe s
    JOIN transcriptions t ON t.workflow_id = s.workflow_id
    WHERE t.created_at >= $1 AND t.created_at < $2

    UNION ALL
    SELECT s.id, GREATEST(n.created_at, COALESCE(n.edited_date, n.created_at))
    FROM augx_notebuilder_notes n
    JOIN scribe s ON (
      n.augx_note_id = ${EXTRACTED_NOTE_ID}
      OR n.scribe_id::text = s.id::text
      OR n.scribe_id::text = ${EXTRACTED_NOTE_ID}
    )
    WHERE n.note_type IN ('MDS_EDIT', 'EHR_UPLOAD', 'PROVIDER_SIGNED')
      AND GREATEST(n.created_at, COALESCE(n.edited_date, n.created_at)) >= $1
      AND GREATEST(n.created_at, COALESCE(n.edited_date, n.created_at)) < $2

    UNION ALL
    SELECT s.id, anvh.created_at
    FROM scribe s
    JOIN ai_workflow_tasks awt ON awt.workflow_id = s.workflow_id
    JOIN augx_note_version_history anvh ON anvh.workflow_task_id = awt.id
    WHERE anvh.version_name IN ('SEND_TO_MDS', 'AI_DRAFT_NOTE', 'MDS_UPLOADED_NOTE')
      AND anvh.created_at >= $1 AND anvh.created_at < $2

    UNION ALL
    SELECT s.id, ssn.created_at
    FROM scribe s
    JOIN scribe_signed_notes ssn ON ssn.appointment_id = s.appointment_id
    WHERE ssn.created_at >= $1 AND ssn.created_at < $2
  ) ev
  GROUP BY ev.scribe_id
),
page AS (
  SELECT c.scribe_id, c.last_activity_at
  FROM changed c
  WHERE $3::timestamptz IS NULL
     OR c.last_activity_at > $3::timestamptz
     OR (c.last_activity_at = $3::timestamptz AND c.scribe_id::text > $4::text)
  ORDER BY c.last_activity_at ASC, c.scribe_id::text ASC
  LIMIT $5
),
ts AS (
  SELECT
    p.scribe_id,
    p.last_activity_at,
    s.appointment_id,
    s.scribe_account_id,
    s.workflow_id,
    s.created_at AS scribe_created_at,
    (s.clinical_documentation IS NOT NULL) AS has_clindoc,
    ${EXTRACTED_NOTE_ID} AS extracted_note_id
  FROM page p
  JOIN scribe s ON s.id = p.scribe_id
),
tr AS (
  SELECT DISTINCT ON (ts.scribe_id)
    ts.scribe_id,
    t.id AS transcription_id,
    t.created_at AS transcription_created_at,
    (t.raw_text IS NOT NULL) AS has_transcript
  FROM ts
  JOIN transcriptions t ON t.workflow_id = ts.workflow_id
  ORDER BY ts.scribe_id, t.created_at DESC
),
augx AS (
  SELECT
    r.scribe_id,
    MAX(CASE WHEN r.note_type = 'MDS_EDIT' THEN r.id END) AS mds_row_id,
    MAX(CASE WHEN r.note_type = 'MDS_EDIT' THEN r.created_at END) AS mds_created,
    MAX(CASE WHEN r.note_type = 'MDS_EDIT' THEN r.edited_date END) AS mds_edited,
    BOOL_OR(r.note_type = 'MDS_EDIT') AS has_mds,
    MAX(CASE WHEN r.note_type = 'EHR_UPLOAD' THEN r.id END) AS ehr_row_id,
    MAX(CASE WHEN r.note_type = 'EHR_UPLOAD' THEN r.created_at END) AS ehr_created,
    MAX(CASE WHEN r.note_type = 'EHR_UPLOAD' THEN r.edited_date END) AS ehr_edited,
    BOOL_OR(r.note_type = 'EHR_UPLOAD') AS has_ehr,
    MAX(CASE WHEN r.note_type = 'PROVIDER_SIGNED' THEN r.id END) AS ps_row_id,
    MAX(CASE WHEN r.note_type = 'PROVIDER_SIGNED' THEN r.created_at END) AS ps_created,
    MAX(CASE WHEN r.note_type = 'PROVIDER_SIGNED' THEN r.edited_date END) AS ps_edited,
    BOOL_OR(r.note_type = 'PROVIDER_SIGNED') AS has_ps,
    MAX(r.augx_note_id) AS latest_augx_note_id
  FROM (
    SELECT
      ts.scribe_id,
      n.id,
      n.note_type,
      n.augx_note_id,
      n.created_at,
      n.edited_date,
      ROW_NUMBER() OVER (
        PARTITION BY ts.scribe_id, n.note_type
        ORDER BY n.created_at DESC, n.id DESC
      ) AS rn
    FROM ts
    JOIN augx_notebuilder_notes n ON (
      n.augx_note_id = ts.extracted_note_id
      OR n.scribe_id::text = ts.scribe_id::text
      OR n.scribe_id::text = ts.extracted_note_id::text
    )
    WHERE n.note_type IN ('MDS_EDIT', 'EHR_UPLOAD', 'PROVIDER_SIGNED')
      AND n.note_content IS NOT NULL
  ) r
  WHERE r.rn = 1
  GROUP BY r.scribe_id
),
anvh AS (
  SELECT
    ls.scribe_id,
    MAX(CASE WHEN ls.version_name = 'SEND_TO_MDS' THEN ls.id END) AS send_id,
    BOOL_OR(ls.version_name = 'SEND_TO_MDS' AND ls.output_text IS NOT NULL) AS has_send,
    MAX(CASE WHEN ls.version_name = 'AI_DRAFT_NOTE' THEN ls.id END) AS draft_id,
    BOOL_OR(ls.version_name = 'AI_DRAFT_NOTE' AND ls.output_text IS NOT NULL) AS has_draft,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.id END) AS mdsu_id,
    BOOL_OR(ls.version_name = 'MDS_UPLOADED_NOTE' AND ls.output_text IS NOT NULL) AS has_mdsu,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.created_at END) AS mdsu_created,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.updated_at::date END) AS mdsu_edited
  FROM (
    SELECT
      anvh.id,
      anvh.created_at,
      anvh.updated_at,
      ts.scribe_id,
      anvh.version_name,
      CASE
        WHEN sat.enforce_json = true THEN aeh.output_json::text
        ELSE aeh.output_text
      END AS output_text
    FROM ts
    JOIN ai_workflow_tasks awt ON awt.workflow_id = ts.workflow_id
    JOIN augx_note_version_history anvh ON awt.id = anvh.workflow_task_id
    JOIN ai_edit_history aeh ON aeh.id = anvh.edit_history_id
    JOIN augx_mds_tasks amt ON anvh.workflow_task_id = amt.workflow_task_id
    JOIN scribe_account_templates sat
      ON ts.scribe_account_id = sat.scribe_account_id AND awt.template_id = sat.template_id
    WHERE anvh.version_name IN ('SEND_TO_MDS', 'MDS_UPLOADED_NOTE', 'AI_DRAFT_NOTE')
  ) ls
  GROUP BY ls.scribe_id
),
ssn AS (
  SELECT DISTINCT ON (ts.scribe_id)
    ts.scribe_id,
    n.id AS ssn_id,
    n.created_at AS ssn_created,
    n.updated_at AS ssn_updated,
    (n.signed_note_raw IS NOT NULL) AS has_signed
  FROM ts
  JOIN scribe_signed_notes n ON n.appointment_id = ts.appointment_id
  ORDER BY ts.scribe_id, n.created_at DESC
)
SELECT
  ts.scribe_id::text AS scribe_id,
  ts.last_activity_at,
  ts.appointment_id::text AS appointment_id,
  ts.scribe_account_id::text AS scribe_account_id,
  ts.scribe_created_at,
  ts.has_clindoc,
  ts.extracted_note_id,
  COALESCE(ts.extracted_note_id, ts.scribe_id::text) AS note_id,
  COALESCE(ts.extracted_note_id, a.latest_augx_note_id) AS augx_note_id,
  tr.transcription_id::text AS transcription_id,
  tr.transcription_created_at,
  COALESCE(tr.has_transcript, false) AS has_transcript,
  a.mds_row_id::text AS mds_row_id, a.mds_created, a.mds_edited, COALESCE(a.has_mds, false) AS has_mds,
  a.ehr_row_id::text AS ehr_row_id, a.ehr_created, a.ehr_edited, COALESCE(a.has_ehr, false) AS has_ehr,
  a.ps_row_id::text AS ps_row_id, a.ps_created, a.ps_edited, COALESCE(a.has_ps, false) AS has_ps,
  v.send_id::text AS send_id, COALESCE(v.has_send, false) AS has_send,
  v.draft_id::text AS draft_id, COALESCE(v.has_draft, false) AS has_draft,
  v.mdsu_id::text AS mdsu_id, COALESCE(v.has_mdsu, false) AS has_mdsu,
  v.mdsu_created, v.mdsu_edited,
  sn.ssn_id::text AS ssn_id, sn.ssn_created, sn.ssn_updated, COALESCE(sn.has_signed, false) AS has_signed
FROM ts
LEFT JOIN tr ON tr.scribe_id = ts.scribe_id
LEFT JOIN augx a ON a.scribe_id = ts.scribe_id
LEFT JOIN anvh v ON v.scribe_id = ts.scribe_id
LEFT JOIN ssn sn ON sn.scribe_id = ts.scribe_id
ORDER BY ts.last_activity_at ASC, ts.scribe_id::text ASC
`;

interface UpdatedNotesRow {
  scribe_id: string;
  last_activity_at: Date;
  appointment_id: string | null;
  scribe_account_id: string | null;
  scribe_created_at: Date | null;
  has_clindoc: boolean;
  extracted_note_id: string | null;
  note_id: string;
  augx_note_id: string | null;
  transcription_id: string | null;
  transcription_created_at: Date | null;
  has_transcript: boolean;
  mds_row_id: string | null;
  mds_created: Date | null;
  mds_edited: Date | null;
  has_mds: boolean;
  ehr_row_id: string | null;
  ehr_created: Date | null;
  ehr_edited: Date | null;
  has_ehr: boolean;
  ps_row_id: string | null;
  ps_created: Date | null;
  ps_edited: Date | null;
  has_ps: boolean;
  send_id: string | null;
  has_send: boolean;
  draft_id: string | null;
  has_draft: boolean;
  mdsu_id: string | null;
  has_mdsu: boolean;
  mdsu_created: Date | null;
  mdsu_edited: Date | null;
  ssn_id: string | null;
  ssn_created: Date | null;
  ssn_updated: Date | null;
  has_signed: boolean;
}

function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/**
 * Assemble the §10 copies[] for one scribe row, mirroring rlGetNoteContent.sql's
 * source-selection logic exactly (see the final SELECT of that file):
 * - transcript: the joined transcriptions row.
 * - mds_copy: AUGX_NOTEBUILDER (MDS_EDIT rn=1) else NORMANDY_TASKS (MDS_UPLOADED_NOTE).
 * - ehr_copy: AUGX EHR_UPLOAD rn=1 only.
 * - signed_copy: NORMANDY_SAVE (scribe_signed_notes) beats AUGX PROVIDER_SIGNED.
 * - ai_copy: on the fallback branch (no AUGX mds_copy but a NORMANDY_TASKS
 *   mds_copy exists) the content comes from SEND_TO_MDS → AI_DRAFT_NOTE →
 *   clinical_documentation; otherwise from clinical_documentation. object_version
 *   is null whenever the content is the computed clinical_documentation (no
 *   single source row — the sync client hashes instead, per the spec).
 */
function buildCopies(row: UpdatedNotesRow): UpdatedNoteCopy[] {
  const copies: UpdatedNoteCopy[] = [];

  if (row.has_transcript && row.transcription_id !== null) {
    copies.push({
      copy_type: 'transcript',
      object_version: `transcriptions:${row.transcription_id}`,
      source_created_at: iso(row.transcription_created_at),
      source_edited_at: null,
    });
  }

  const aiFallbackBranch = !row.has_mds && row.has_mdsu;
  let aiExists: boolean;
  let aiVersion: string | null = null;
  if (aiFallbackBranch) {
    aiExists = row.has_send || row.has_draft || row.has_clindoc;
    if (row.has_send && row.send_id !== null) aiVersion = `augx_note_version_history:${row.send_id}`;
    else if (row.has_draft && row.draft_id !== null) aiVersion = `augx_note_version_history:${row.draft_id}`;
  } else {
    aiExists = row.has_clindoc;
  }
  if (aiExists) {
    copies.push({
      copy_type: 'ai_copy',
      object_version: aiVersion,
      source_created_at: iso(row.scribe_created_at),
      source_edited_at: null,
    });
  }

  if (row.has_mds && row.mds_row_id !== null) {
    copies.push({
      copy_type: 'mds_copy',
      object_version: `augx_notebuilder_notes:${row.mds_row_id}`,
      source_created_at: iso(row.mds_created),
      source_edited_at: iso(row.mds_edited),
    });
  } else if (row.has_mdsu && row.mdsu_id !== null) {
    copies.push({
      copy_type: 'mds_copy',
      object_version: `augx_note_version_history:${row.mdsu_id}`,
      source_created_at: iso(row.mdsu_created),
      source_edited_at: iso(row.mdsu_edited),
    });
  }

  if (row.has_ehr && row.ehr_row_id !== null) {
    copies.push({
      copy_type: 'ehr_copy',
      object_version: `augx_notebuilder_notes:${row.ehr_row_id}`,
      source_created_at: iso(row.ehr_created),
      source_edited_at: iso(row.ehr_edited),
    });
  }

  if (row.has_signed && row.ssn_id !== null) {
    copies.push({
      copy_type: 'signed_copy',
      object_version: `scribe_signed_notes:${row.ssn_id}`,
      source_created_at: iso(row.ssn_created),
      source_edited_at: iso(row.ssn_updated),
    });
  } else if (row.has_ps && row.ps_row_id !== null) {
    copies.push({
      copy_type: 'signed_copy',
      object_version: `augx_notebuilder_notes:${row.ps_row_id}`,
      source_created_at: iso(row.ps_created),
      source_edited_at: iso(row.ps_edited),
    });
  }

  return copies;
}

export async function cronusGetUpdatedNotes(rawInput: unknown): Promise<GetUpdatedNotesResult> {
  const input = getUpdatedNotesInput.parse(rawInput);
  const pageSize = input.page_size ?? 100;
  const until = input.until_ts ?? new Date().toISOString();
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;

  const { rows } = await normandyDb().query<UpdatedNotesRow>(UPDATED_NOTES_SQL, [
    input.since_ts,
    until,
    cursor?.t ?? null,
    cursor?.s ?? null,
    pageSize,
  ]);

  const notes: UpdatedNote[] = rows.map((row) => ({
    note_id: row.note_id,
    scribe_id: row.scribe_id,
    augx_note_id: row.augx_note_id,
    appointment_id: row.appointment_id,
    scribe_account_id: row.scribe_account_id,
    // Warehouse-only fields; see module header. Nullable per the spec.
    clinician_sf_id: null,
    date_of_service: null,
    last_activity_at: iso(row.last_activity_at) as string,
    copies: buildCopies(row),
  }));

  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === pageSize && last
      ? encodeCursor({ t: iso(last.last_activity_at) as string, s: last.scribe_id })
      : null;

  console.log('[cronus.getUpdatedNotes] rowCount=%d has_next=%s', notes.length, String(next_cursor !== null));
  return { notes, next_cursor };
}

// --- §11 cronus_getNoteContentBulk ------------------------------------------

const getNoteContentBulkInput = z.object({
  note_ids: z.array(z.string().min(1)).min(1).max(25),
});

export interface NoteContentRow {
  note_id: string;
  scribe_id: string | null;
  appointment_id: string | null;
  scribe_account_id: string | null;
  transcript: string | null;
  ai_copy: string | null;
  mds_copy: string | null;
  ehr_copy: string | null;
  signed_copy: string | null;
  signed_copy_type: 'NORMANDY_SAVE' | 'AUGX' | null;
  ai_copy_created_time: string | null;
  mds_copy_created_time: string | null;
  ehr_copy_created_time: string | null;
  signed_copy_created_time: string | null;
  mds_copy_edited_time: string | null;
  ehr_copy_edited_time: string | null;
  signed_copy_edited_time: string | null;
  mds_copy_edited_by: string | null;
  ehr_copy_edited_by: string | null;
  signed_copy_edited_by: string | null;
  transcript_version: string | null;
  ai_copy_version: string | null;
  mds_copy_version: string | null;
  ehr_copy_version: string | null;
  signed_copy_version: string | null;
}

export type BulkNoteContent = NoteContentRow | { note_id: string; error: 'NOT_FOUND' };

/**
 * Batched port of reference/sql/rlGetNoteContent.sql (Cronus repo). The 5-step
 * CTE pipeline is preserved wholesale — per the §4 implementation note, "wrap
 * that whole pipeline; do not split it" — with three mechanical changes:
 * 1. target_scribe resolves one scribe per REQUESTED note_id (DISTINCT ON +
 *    the identical match predicate) instead of a single {{ note_id }}.
 * 2. signed_sn_data's global LIMIT 1 becomes DISTINCT ON (appointment_id).
 * 3. Ranked/aggregated CTEs additionally surface the rn=1 source-row ids so
 *    the final SELECT can emit the five *_version fields (§4 amendment / §11).
 */
const NOTE_CONTENT_BULK_SQL = `
WITH req AS (
  SELECT DISTINCT unnest($1::text[]) AS note_id
),
target_scribe AS (
  SELECT DISTINCT ON (req.note_id)
    req.note_id AS req_note_id,
    s.id AS scribe_id,
    s.appointment_id,
    s.scribe_account_id,
    s.created_at,
    s.clinical_documentation,
    s.workflow_id,
    ${EXTRACTED_NOTE_ID} AS extracted_note_id,
    t.raw_text AS raw_transcript,
    t.id AS transcription_id
  FROM req
  JOIN scribe s ON (${EXTRACTED_NOTE_ID} = req.note_id OR s.id::text = req.note_id)
  JOIN transcriptions t ON s.workflow_id = t.workflow_id
  ORDER BY req.note_id, s.created_at DESC
),
augx_summary AS (
  SELECT
    rn.scribe_id,
    MAX(CASE WHEN rn.note_type = 'MDS_EDIT' THEN rn.created_at END) AS mds_copy_created_time,
    MAX(CASE WHEN rn.note_type = 'MDS_EDIT' THEN rn.edited_date END) AS mds_copy_edited_time,
    MAX(CASE WHEN rn.note_type = 'MDS_EDIT' THEN rn.edited_by END) AS mds_copy_edited_by,
    MAX(CASE WHEN rn.note_type = 'MDS_EDIT' THEN rn.note_content END) AS mds_copy,
    MAX(CASE WHEN rn.note_type = 'MDS_EDIT' THEN rn.id END) AS mds_row_id,
    MAX(CASE WHEN rn.note_type = 'EHR_UPLOAD' THEN rn.created_at END) AS ehr_copy_created_time,
    MAX(CASE WHEN rn.note_type = 'EHR_UPLOAD' THEN rn.edited_date END) AS ehr_copy_edited_time,
    MAX(CASE WHEN rn.note_type = 'EHR_UPLOAD' THEN rn.edited_by END) AS ehr_copy_edited_by,
    MAX(CASE WHEN rn.note_type = 'EHR_UPLOAD' THEN rn.note_content END) AS ehr_copy,
    MAX(CASE WHEN rn.note_type = 'EHR_UPLOAD' THEN rn.id END) AS ehr_row_id,
    MAX(CASE WHEN rn.note_type = 'PROVIDER_SIGNED' THEN rn.note_content END) AS augx_signed_content,
    MAX(CASE WHEN rn.note_type = 'PROVIDER_SIGNED' THEN rn.created_at END) AS augx_signed_created_at,
    MAX(CASE WHEN rn.note_type = 'PROVIDER_SIGNED' THEN rn.edited_date END) AS augx_signed_edited_date,
    MAX(CASE WHEN rn.note_type = 'PROVIDER_SIGNED' THEN rn.edited_by END) AS augx_signed_edited_by,
    MAX(CASE WHEN rn.note_type = 'PROVIDER_SIGNED' THEN rn.id END) AS ps_row_id,
    MAX(rn.augx_note_id) AS latest_augx_note_id
  FROM (
    SELECT
      ts.scribe_id,
      n.id,
      n.note_type,
      n.note_content,
      n.created_at,
      n.edited_date,
      n.edited_by,
      n.augx_note_id,
      ROW_NUMBER() OVER (
        PARTITION BY ts.scribe_id, n.note_type
        ORDER BY n.created_at DESC, n.id DESC
      ) AS rn
    FROM target_scribe ts
    JOIN augx_notebuilder_notes n ON (
      n.augx_note_id = ts.extracted_note_id
      OR n.scribe_id::text = ts.scribe_id::text
      OR n.scribe_id::text = ts.extracted_note_id::text
    )
    WHERE n.note_type IN ('MDS_EDIT', 'EHR_UPLOAD', 'PROVIDER_SIGNED')
      AND n.note_content IS NOT NULL
  ) rn
  WHERE rn.rn = 1
  GROUP BY rn.scribe_id
),
signed_sn_data AS (
  SELECT DISTINCT ON (appointment_id)
    id,
    appointment_id,
    signed_note_raw,
    created_at,
    updated_at,
    source
  FROM scribe_signed_notes
  WHERE appointment_id IN (SELECT appointment_id FROM target_scribe)
  ORDER BY appointment_id, created_at DESC
),
normandy_mds_fallback AS (
  SELECT
    ls.scribe_id,
    MAX(CASE WHEN ls.version_name = 'SEND_TO_MDS' THEN ls.output_text END) AS send_text,
    MAX(CASE WHEN ls.version_name = 'SEND_TO_MDS' THEN ls.id END) AS send_id,
    MAX(CASE WHEN ls.version_name = 'AI_DRAFT_NOTE' THEN ls.output_text END) AS draft_text,
    MAX(CASE WHEN ls.version_name = 'AI_DRAFT_NOTE' THEN ls.id END) AS draft_id,
    COALESCE(
      MAX(CASE WHEN ls.version_name = 'SEND_TO_MDS' THEN ls.output_text END),
      MAX(CASE WHEN ls.version_name = 'AI_DRAFT_NOTE' THEN ls.output_text END),
      MAX(ls.clinical_documentation)
    ) AS ai_draft_content,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.output_text END) AS mds_edit_content,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.id END) AS mdsu_id,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.created_at END) AS mds_created_at,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.updated_at::date END) AS mds_edited_date,
    MAX(CASE WHEN ls.version_name = 'MDS_UPLOADED_NOTE' THEN ls.mds_user_id::text END) AS mds_edited_by
  FROM (
    SELECT
      anvh.created_at,
      anvh.updated_at,
      anvh.id,
      ts.scribe_id,
      ts.clinical_documentation,
      amt.mds_user_id,
      anvh.version_name,
      CASE
        WHEN sat.enforce_json = true THEN aeh.output_json::text
        ELSE aeh.output_text
      END AS output_text
    FROM target_scribe ts
    JOIN ai_workflow_tasks awt ON awt.workflow_id = ts.workflow_id
    JOIN augx_note_version_history anvh ON awt.id = anvh.workflow_task_id
    JOIN ai_edit_history aeh ON aeh.id = anvh.edit_history_id
    JOIN augx_mds_tasks amt ON anvh.workflow_task_id = amt.workflow_task_id
    JOIN scribe_account_templates sat
      ON ts.scribe_account_id = sat.scribe_account_id AND awt.template_id = sat.template_id
    WHERE version_name IN ('SEND_TO_MDS', 'MDS_UPLOADED_NOTE', 'AI_DRAFT_NOTE')
  ) ls
  GROUP BY ls.scribe_id
)
SELECT
  s.req_note_id AS note_id,
  s.scribe_id::text AS scribe_id,
  s.appointment_id::text AS appointment_id,
  s.scribe_account_id::text AS scribe_account_id,
  s.raw_transcript AS transcript,
  CASE
    WHEN a.mds_copy IS NULL AND nmf.mds_edit_content IS NOT NULL THEN nmf.ai_draft_content
    ELSE s.clinical_documentation
  END AS ai_copy,
  s.created_at AS ai_copy_created_time,
  COALESCE(a.mds_copy_created_time, nmf.mds_created_at) AS mds_copy_created_time,
  COALESCE(a.mds_copy_edited_time, nmf.mds_edited_date) AS mds_copy_edited_time,
  COALESCE(a.mds_copy_edited_by, nmf.mds_edited_by) AS mds_copy_edited_by,
  COALESCE(a.mds_copy, nmf.mds_edit_content) AS mds_copy,
  a.ehr_copy_created_time,
  a.ehr_copy_edited_time,
  a.ehr_copy_edited_by,
  a.ehr_copy,
  CASE
    WHEN sn.signed_note_raw IS NOT NULL THEN 'NORMANDY_SAVE'
    WHEN a.augx_signed_content IS NOT NULL THEN 'AUGX'
    ELSE NULL
  END AS signed_copy_type,
  COALESCE(a.augx_signed_content, sn.signed_note_raw::text) AS signed_copy,
  COALESCE(a.augx_signed_created_at, sn.created_at) AS signed_copy_created_time,
  COALESCE(a.augx_signed_edited_date, sn.updated_at) AS signed_copy_edited_time,
  COALESCE(a.augx_signed_edited_by, sn.source::text) AS signed_copy_edited_by,
  CASE WHEN s.raw_transcript IS NOT NULL THEN 'transcriptions:' || s.transcription_id::text END AS transcript_version,
  CASE
    WHEN a.mds_copy IS NULL AND nmf.mds_edit_content IS NOT NULL THEN
      CASE
        WHEN nmf.send_text IS NOT NULL THEN 'augx_note_version_history:' || nmf.send_id::text
        WHEN nmf.draft_text IS NOT NULL THEN 'augx_note_version_history:' || nmf.draft_id::text
        ELSE NULL
      END
    ELSE NULL
  END AS ai_copy_version,
  CASE
    WHEN a.mds_copy IS NOT NULL THEN 'augx_notebuilder_notes:' || a.mds_row_id::text
    WHEN nmf.mds_edit_content IS NOT NULL THEN 'augx_note_version_history:' || nmf.mdsu_id::text
    ELSE NULL
  END AS mds_copy_version,
  CASE
    WHEN a.ehr_copy IS NOT NULL THEN 'augx_notebuilder_notes:' || a.ehr_row_id::text
    ELSE NULL
  END AS ehr_copy_version,
  CASE
    WHEN sn.signed_note_raw IS NOT NULL THEN 'scribe_signed_notes:' || sn.id::text
    WHEN a.augx_signed_content IS NOT NULL THEN 'augx_notebuilder_notes:' || a.ps_row_id::text
    ELSE NULL
  END AS signed_copy_version
FROM target_scribe s
LEFT JOIN augx_summary a ON s.scribe_id = a.scribe_id
LEFT JOIN signed_sn_data sn ON s.appointment_id = sn.appointment_id
LEFT JOIN normandy_mds_fallback nmf ON s.scribe_id = nmf.scribe_id
`;

interface BulkRawRow {
  note_id: string;
  scribe_id: string | null;
  appointment_id: string | null;
  scribe_account_id: string | null;
  transcript: string | null;
  ai_copy: string | null;
  mds_copy: string | null;
  ehr_copy: string | null;
  signed_copy: string | null;
  signed_copy_type: 'NORMANDY_SAVE' | 'AUGX' | null;
  ai_copy_created_time: Date | null;
  mds_copy_created_time: Date | null;
  ehr_copy_created_time: Date | null;
  signed_copy_created_time: Date | null;
  mds_copy_edited_time: Date | null;
  ehr_copy_edited_time: Date | null;
  signed_copy_edited_time: Date | null;
  mds_copy_edited_by: string | null;
  ehr_copy_edited_by: string | null;
  signed_copy_edited_by: string | null;
  transcript_version: string | null;
  ai_copy_version: string | null;
  mds_copy_version: string | null;
  ehr_copy_version: string | null;
  signed_copy_version: string | null;
}

export async function cronusGetNoteContentBulk(rawInput: unknown): Promise<BulkNoteContent[]> {
  const input = getNoteContentBulkInput.parse(rawInput);

  const { rows } = await normandyDb().query<BulkRawRow>(NOTE_CONTENT_BULK_SQL, [input.note_ids]);

  const byNoteId = new Map<string, BulkRawRow>();
  for (const row of rows) byNoteId.set(row.note_id, row);

  // Spec: missing notes come back as { note_id, error: "NOT_FOUND" } — never
  // silently dropped. Preserve the caller's order.
  const out: BulkNoteContent[] = input.note_ids.map((id) => {
    const row = byNoteId.get(id);
    if (!row) return { note_id: id, error: 'NOT_FOUND' as const };
    return {
      note_id: row.note_id,
      scribe_id: row.scribe_id,
      appointment_id: row.appointment_id,
      scribe_account_id: row.scribe_account_id,
      transcript: row.transcript,
      ai_copy: row.ai_copy,
      mds_copy: row.mds_copy,
      ehr_copy: row.ehr_copy,
      signed_copy: row.signed_copy,
      signed_copy_type: row.signed_copy_type,
      ai_copy_created_time: iso(row.ai_copy_created_time),
      mds_copy_created_time: iso(row.mds_copy_created_time),
      ehr_copy_created_time: iso(row.ehr_copy_created_time),
      signed_copy_created_time: iso(row.signed_copy_created_time),
      mds_copy_edited_time: iso(row.mds_copy_edited_time),
      ehr_copy_edited_time: iso(row.ehr_copy_edited_time),
      signed_copy_edited_time: iso(row.signed_copy_edited_time),
      mds_copy_edited_by: row.mds_copy_edited_by,
      ehr_copy_edited_by: row.ehr_copy_edited_by,
      signed_copy_edited_by: row.signed_copy_edited_by,
      transcript_version: row.transcript_version,
      ai_copy_version: row.ai_copy_version,
      mds_copy_version: row.mds_copy_version,
      ehr_copy_version: row.ehr_copy_version,
      signed_copy_version: row.signed_copy_version,
    };
  });

  const found = out.filter((r) => !('error' in r)).length;
  console.log('[cronus.getNoteContentBulk] requested=%d found=%d not_found=%d', input.note_ids.length, found, out.length - found);
  return out;
}

// --- instrumented handlers (shared by /tools/call and /mcp) ------------------

export const runCronusGetUpdatedNotes = instrumented(
  'cronus',
  'cronus_getUpdatedNotes',
  cronusGetUpdatedNotes,
  (out) => ({ rowCount: out.notes.length, has_next: out.next_cursor !== null }),
);

export const runCronusGetNoteContentBulk = instrumented(
  'cronus',
  'cronus_getNoteContentBulk',
  cronusGetNoteContentBulk,
  (out) => ({
    rowCount: out.length,
    not_found: out.filter((r) => 'error' in r).length,
  }),
);

// --- MCP registration ---------------------------------------------------------

export function registerCronusTools(server: McpServer): void {
  server.registerTool(
    'cronus_getUpdatedNotes',
    {
      description:
        'CRONUS note-cache change index (spec §10). Returns which notes changed in ' +
        '[since_ts, until_ts) and which copy types exist, with per-copy object_version — ' +
        'NO note content. Keyset-paged ascending by (last_activity_at, scribe_id).',
      inputSchema: {
        since_ts: z.string().datetime({ offset: true }),
        until_ts: z.string().datetime({ offset: true }).optional(),
        cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(500).optional(),
      },
    },
    async (input) => asMcpTextContent(await runCronusGetUpdatedNotes(input)),
  );

  server.registerTool(
    'cronus_getNoteContentBulk',
    {
      description:
        'CRONUS bulk note content (spec §11): full 5-copy content + per-copy version ' +
        'fields for up to 25 note_ids. Missing notes are returned as ' +
        '{ note_id, error: "NOT_FOUND" }. Contains PHI — never log the response.',
      inputSchema: {
        note_ids: z.array(z.string().min(1)).min(1).max(25),
      },
    },
    async (input) => asMcpTextContent(await runCronusGetNoteContentBulk(input)),
  );
}
