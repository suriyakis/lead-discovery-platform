// KL-05 owner-review report: what the knowledge-scope migration
// (drizzle p1_knowledge_foundation_knowledge_scope + _contract) does to a
// database, before it runs — and what it left behind, after.
//
// READ-ONLY. It never writes; the CLI (scripts/remediation/
// knowledge-scope-report.ts) runs it inside a READ ONLY transaction.
//
// Before the migration (`pre_kl05` shape: knowledge_sources still has the
// product_profile_ids array) it lists, with the same conditions the
// migration's SQL uses:
//   * the counts the design asks for in the PR: documents, sources,
//     document-level chunks, source chunks and documents having both;
//   * SHADOWED — document-level chunks of documents that have a source with
//     products ticked (the I039 leak). The migration deletes them;
//   * BECOMES WORKSPACE-WIDE — documents whose document-level chunks are
//     not shadowed. The migration turns each into one workspace-wide
//     source, i.e. available to every product (as they already were). This
//     is the owner-review list: archive a document that must not be used,
//     or tick products on its source after the deploy (no re-index);
//   * NEEDS A SCOPE — sources left with no valid product (an empty array,
//     or only another tenant's / deleted products). Retrieved nowhere
//     until someone ticks products or makes them workspace-wide;
//   * product ids the backfill drops, and chunks that would trip the
//     migration's guard.
// After the migration (`post_kl05`) it prints the live counts, the
// sources the migration created (from its audit rows) with their current
// scope, and every source that needs a scope.
//
// Raw SQL on purpose: the pre-migration columns are no longer in the
// Drizzle schema. Every value is a bound parameter.

import type postgres from 'postgres';

export type ReportSql = Pick<postgres.Sql, 'unsafe'>;

export interface KnowledgeScopeReportOptions {
  /** Limit to these workspaces (ids as decimal strings). */
  workspaceIds?: readonly string[];
}

export interface WorkspaceWideCandidate {
  workspaceId: string;
  workspaceName: string | null;
  documentId: string;
  name: string;
  filename: string;
  status: string;
  createdAt: string;
  chunks: number;
  /** Sources already wrapping the document with NO product ticked. */
  unscopedSourceIds: string[];
}

export interface ShadowedDocument {
  workspaceId: string;
  documentId: string;
  name: string | null;
  chunks: number;
  productSourceIds: string[];
}

export interface NeedsScopeSource {
  workspaceId: string;
  workspaceName: string | null;
  sourceId: string;
  kind: string;
  title: string;
  reason: 'no_products' | 'only_foreign_or_deleted_products' | 'products_deleted';
  droppedProductIds: string[];
}

export interface PartiallyDroppedSource {
  workspaceId: string;
  sourceId: string;
  keptProductIds: string[];
  droppedProductIds: string[];
}

export interface MigratedSource {
  workspaceId: string;
  sourceId: string;
  documentId: string | null;
  title: string | null;
  /** Current scope ('gone' when the source was deleted since). */
  scope: 'workspace' | 'products' | 'needs_scope' | 'gone';
  documentStatus: string | null;
  chunksAtMigration: number;
}

export interface KnowledgeScopeReport {
  shape: 'pre_kl05' | 'post_kl05';
  generatedAt: string;
  workspaceIds: string[] | null;
  counts: Record<string, number>;
  sourcesByKind: Record<string, number>;
  /** pre: documents that become workspace-wide sources (owner review). */
  becomesWorkspaceWide: WorkspaceWideCandidate[];
  /** pre: documents whose document-level chunks are deleted. */
  shadowed: ShadowedDocument[];
  needsScope: NeedsScopeSource[];
  /** pre: sources that keep some products and lose others. */
  partiallyDropped: PartiallyDroppedSource[];
  /** post: sources the migration created, as they are now. */
  migratedSources: MigratedSource[];
}

const WS_FILTER = (alias: string) =>
  `($1::text IS NULL OR ${alias}.workspace_id = ANY(string_to_array($1::text, ',')::bigint[]))`;

function filterParam(opts: KnowledgeScopeReportOptions): string | null {
  const ids = (opts.workspaceIds ?? []).filter((id) => /^\d+$/.test(id));
  return ids.length > 0 ? ids.join(',') : null;
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export async function detectShape(sql: ReportSql): Promise<'pre_kl05' | 'post_kl05'> {
  const rows = await sql.unsafe(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'knowledge_sources'
         AND column_name = 'product_profile_ids'
     ) AS pre`,
  );
  return rows[0]?.pre ? 'pre_kl05' : 'post_kl05';
}

export async function buildKnowledgeScopeReport(
  sql: ReportSql,
  opts: KnowledgeScopeReportOptions = {},
): Promise<KnowledgeScopeReport> {
  const shape = await detectShape(sql);
  const ws = filterParam(opts);
  const base: KnowledgeScopeReport = {
    shape,
    generatedAt: new Date().toISOString(),
    workspaceIds: ws ? ws.split(',') : null,
    counts: {},
    sourcesByKind: {},
    becomesWorkspaceWide: [],
    shadowed: [],
    needsScope: [],
    partiallyDropped: [],
    migratedSources: [],
  };
  const kinds = await sql.unsafe(
    `SELECT ks.kind::text AS kind, count(*)::int AS n FROM knowledge_sources ks
     WHERE ${WS_FILTER('ks')} GROUP BY 1 ORDER BY 1`,
    [ws],
  );
  base.sourcesByKind = Object.fromEntries(kinds.map((r) => [str(r.kind), num(r.n)]));
  return shape === 'pre_kl05' ? preReport(sql, ws, base) : postReport(sql, ws, base);
}

// A source "has products ticked" exactly as the migration's shadow step
// reads it: a non-empty array, whatever the ids point at.
const HAS_TICKED_PRODUCTS = `cardinality(ks.product_profile_ids) > 0`;

async function preReport(
  sql: ReportSql,
  ws: string | null,
  report: KnowledgeScopeReport,
): Promise<KnowledgeScopeReport> {
  const [c] = await sql.unsafe(
    `SELECT
       (SELECT count(*) FROM documents d WHERE ${WS_FILTER('d')})::int AS documents,
       (SELECT count(*) FROM documents d WHERE ${WS_FILTER('d')} AND d.status = 'archived')::int AS documents_archived,
       (SELECT count(*) FROM knowledge_sources ks WHERE ${WS_FILTER('ks')})::int AS sources,
       (SELECT count(*) FROM document_chunks c
          WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL AND c.document_id IS NOT NULL)::int AS document_level_chunks,
       (SELECT count(*) FROM document_chunks c
          WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NOT NULL)::int AS source_chunks,
       (SELECT count(*) FROM document_chunks c
          WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL AND c.document_id IS NULL)::int AS orphan_chunks,
       (SELECT count(DISTINCT c.document_id) FROM document_chunks c
          WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL AND c.document_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM knowledge_sources ks
              JOIN document_chunks sc ON sc.knowledge_source_id = ks.id
              WHERE ks.document_id = c.document_id AND ks.workspace_id = c.workspace_id
            ))::int AS documents_with_both,
       (SELECT count(*) FROM knowledge_sources ks, unnest(ks.product_profile_ids) AS u(pid)
          WHERE ${WS_FILTER('ks')}
            AND NOT EXISTS (
              SELECT 1 FROM product_profiles p WHERE p.id = u.pid AND p.workspace_id = ks.workspace_id
            ))::int AS dropped_product_ids,
       (SELECT count(*) FROM document_chunks c
          WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL AND c.document_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.document_id AND d.workspace_id = c.workspace_id)
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_sources ks
              WHERE ks.document_id = c.document_id AND ks.workspace_id = c.workspace_id AND ${HAS_TICKED_PRODUCTS}
            ))::int AS guard_blocking_chunks`,
    [ws],
  );

  const shadowed = await sql.unsafe(
    `SELECT c.workspace_id::text AS workspace_id, c.document_id::text AS document_id,
            max(d.name) AS name, count(*)::int AS chunks,
            array(
              SELECT ks.id::text FROM knowledge_sources ks
              WHERE ks.document_id = c.document_id AND ks.workspace_id = c.workspace_id
                AND ${HAS_TICKED_PRODUCTS}
              ORDER BY ks.id
            ) AS product_source_ids
     FROM document_chunks c
     LEFT JOIN documents d ON d.id = c.document_id AND d.workspace_id = c.workspace_id
     WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL AND c.document_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM knowledge_sources ks
         WHERE ks.document_id = c.document_id AND ks.workspace_id = c.workspace_id AND ${HAS_TICKED_PRODUCTS}
       )
     GROUP BY c.workspace_id, c.document_id
     ORDER BY c.workspace_id, c.document_id`,
    [ws],
  );
  report.shadowed = shadowed.map((r) => ({
    workspaceId: str(r.workspace_id),
    documentId: str(r.document_id),
    name: r.name === null ? null : str(r.name),
    chunks: num(r.chunks),
    productSourceIds: strs(r.product_source_ids),
  }));

  const wide = await sql.unsafe(
    `SELECT d.workspace_id::text AS workspace_id, w.name AS workspace_name,
            d.id::text AS document_id, d.name, d.filename, d.status::text AS status,
            d.created_at, count(c.id)::int AS chunks,
            array(
              SELECT ks.id::text FROM knowledge_sources ks
              WHERE ks.document_id = d.id AND ks.workspace_id = d.workspace_id
              ORDER BY ks.id
            ) AS unscoped_source_ids
     FROM document_chunks c
     JOIN documents d ON d.id = c.document_id AND d.workspace_id = c.workspace_id
     LEFT JOIN workspaces w ON w.id = d.workspace_id
     WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_sources ks
         WHERE ks.document_id = c.document_id AND ks.workspace_id = c.workspace_id AND ${HAS_TICKED_PRODUCTS}
       )
     GROUP BY d.workspace_id, w.name, d.id
     ORDER BY d.workspace_id, d.id`,
    [ws],
  );
  report.becomesWorkspaceWide = wide.map((r) => ({
    workspaceId: str(r.workspace_id),
    workspaceName: r.workspace_name === null ? null : str(r.workspace_name),
    documentId: str(r.document_id),
    name: str(r.name),
    filename: str(r.filename),
    status: str(r.status),
    createdAt: iso(r.created_at),
    chunks: num(r.chunks),
    unscopedSourceIds: strs(r.unscoped_source_ids),
  }));

  const sources = await sql.unsafe(
    `SELECT ks.workspace_id::text AS workspace_id, w.name AS workspace_name,
            ks.id::text AS source_id, ks.kind::text AS kind, ks.title,
            cardinality(ks.product_profile_ids)::int AS ticked,
            array(
              SELECT u.pid::text FROM unnest(ks.product_profile_ids) AS u(pid)
              WHERE EXISTS (SELECT 1 FROM product_profiles p WHERE p.id = u.pid AND p.workspace_id = ks.workspace_id)
              ORDER BY u.pid
            ) AS kept,
            array(
              SELECT u.pid::text FROM unnest(ks.product_profile_ids) AS u(pid)
              WHERE NOT EXISTS (SELECT 1 FROM product_profiles p WHERE p.id = u.pid AND p.workspace_id = ks.workspace_id)
              ORDER BY u.pid
            ) AS dropped
     FROM knowledge_sources ks
     LEFT JOIN workspaces w ON w.id = ks.workspace_id
     WHERE ${WS_FILTER('ks')}
     ORDER BY ks.workspace_id, ks.id`,
    [ws],
  );
  for (const r of sources) {
    const kept = strs(r.kept);
    const dropped = strs(r.dropped);
    if (kept.length === 0) {
      report.needsScope.push({
        workspaceId: str(r.workspace_id),
        workspaceName: r.workspace_name === null ? null : str(r.workspace_name),
        sourceId: str(r.source_id),
        kind: str(r.kind),
        title: str(r.title),
        reason: num(r.ticked) === 0 ? 'no_products' : 'only_foreign_or_deleted_products',
        droppedProductIds: dropped,
      });
    } else if (dropped.length > 0) {
      report.partiallyDropped.push({
        workspaceId: str(r.workspace_id),
        sourceId: str(r.source_id),
        keptProductIds: kept,
        droppedProductIds: dropped,
      });
    }
  }

  report.counts = {
    documents: num(c?.documents),
    documentsArchived: num(c?.documents_archived),
    sources: num(c?.sources),
    documentLevelChunks: num(c?.document_level_chunks),
    sourceChunks: num(c?.source_chunks),
    documentsWithBoth: num(c?.documents_with_both),
    orphanChunks: num(c?.orphan_chunks),
    shadowedDocuments: report.shadowed.length,
    shadowedChunks: report.shadowed.reduce((n, d) => n + d.chunks, 0),
    becomesWorkspaceWideDocuments: report.becomesWorkspaceWide.length,
    becomesWorkspaceWideChunks: report.becomesWorkspaceWide.reduce((n, d) => n + d.chunks, 0),
    sourcesNeedingScope: report.needsScope.length,
    droppedProductIds: num(c?.dropped_product_ids),
    guardBlockingChunks: num(c?.guard_blocking_chunks),
  };
  return report;
}

async function postReport(
  sql: ReportSql,
  ws: string | null,
  report: KnowledgeScopeReport,
): Promise<KnowledgeScopeReport> {
  const NEEDS_SCOPE = `ks.scope_kind = 'products' AND NOT EXISTS (
      SELECT 1 FROM knowledge_source_products p WHERE p.source_id = ks.id AND p.workspace_id = ks.workspace_id)`;
  const [c] = await sql.unsafe(
    `SELECT
       (SELECT count(*) FROM documents d WHERE ${WS_FILTER('d')})::int AS documents,
       (SELECT count(*) FROM documents d WHERE ${WS_FILTER('d')} AND d.status = 'archived')::int AS documents_archived,
       (SELECT count(*) FROM knowledge_sources ks WHERE ${WS_FILTER('ks')})::int AS sources,
       (SELECT count(*) FROM knowledge_sources ks WHERE ${WS_FILTER('ks')} AND ks.scope_kind = 'workspace')::int AS workspace_sources,
       (SELECT count(*) FROM knowledge_sources ks WHERE ${WS_FILTER('ks')} AND ks.scope_kind = 'products')::int AS product_sources,
       (SELECT count(*) FROM knowledge_sources ks WHERE ${WS_FILTER('ks')} AND ${NEEDS_SCOPE})::int AS needs_scope,
       (SELECT count(*) FROM document_chunks c WHERE ${WS_FILTER('c')})::int AS chunks,
       (SELECT count(*) FROM document_chunks c WHERE ${WS_FILTER('c')} AND c.knowledge_source_id IS NULL)::int AS chunks_without_source,
       (SELECT count(*) FROM document_chunks c WHERE ${WS_FILTER('c')} AND c.document_id IS NOT NULL)::int AS chunks_with_legacy_document_id,
       (SELECT count(*) FROM (
          SELECT ks.document_id FROM knowledge_sources ks
          WHERE ${WS_FILTER('ks')} AND ks.document_id IS NOT NULL
          GROUP BY ks.document_id HAVING count(*) > 1) m)::int AS documents_with_several_sources`,
    [ws],
  );
  report.counts = {
    documents: num(c?.documents),
    documentsArchived: num(c?.documents_archived),
    sources: num(c?.sources),
    workspaceSources: num(c?.workspace_sources),
    productSources: num(c?.product_sources),
    sourcesNeedingScope: num(c?.needs_scope),
    chunks: num(c?.chunks),
    chunksWithoutSource: num(c?.chunks_without_source),
    chunksWithLegacyDocumentId: num(c?.chunks_with_legacy_document_id),
    documentsWithSeveralSources: num(c?.documents_with_several_sources),
  };

  const migrated = await sql.unsafe(
    `SELECT a.workspace_id::text AS workspace_id, a.entity_id AS source_id,
            a.payload->>'documentId' AS document_id,
            coalesce((a.payload->>'chunks')::int, 0) AS chunks,
            ks.title, ks.scope_kind::text AS scope_kind,
            (${NEEDS_SCOPE.replace(/\n\s*/g, ' ')}) AS needs_scope,
            d.status::text AS document_status
     FROM audit_log a
     LEFT JOIN knowledge_sources ks ON ks.id::text = a.entity_id AND ks.workspace_id = a.workspace_id
     LEFT JOIN documents d ON d.id = ks.document_id
     WHERE a.kind = 'knowledge_source.scope_backfill' AND ${WS_FILTER('a')}
     ORDER BY a.workspace_id, a.id`,
    [ws],
  );
  report.migratedSources = migrated.map((r) => ({
    workspaceId: str(r.workspace_id),
    sourceId: str(r.source_id),
    documentId: r.document_id === null ? null : str(r.document_id),
    title: r.title === null ? null : str(r.title),
    scope:
      r.scope_kind === null
        ? 'gone'
        : r.needs_scope
          ? 'needs_scope'
          : r.scope_kind === 'workspace'
            ? 'workspace'
            : 'products',
    documentStatus: r.document_status === null ? null : str(r.document_status),
    chunksAtMigration: num(r.chunks),
  }));

  const needs = await sql.unsafe(
    `SELECT ks.workspace_id::text AS workspace_id, w.name AS workspace_name,
            ks.id::text AS source_id, ks.kind::text AS kind, ks.title
     FROM knowledge_sources ks
     LEFT JOIN workspaces w ON w.id = ks.workspace_id
     WHERE ${WS_FILTER('ks')} AND ${NEEDS_SCOPE}
     ORDER BY ks.workspace_id, ks.id`,
    [ws],
  );
  report.needsScope = needs.map((r) => ({
    workspaceId: str(r.workspace_id),
    workspaceName: r.workspace_name === null ? null : str(r.workspace_name),
    sourceId: str(r.source_id),
    kind: str(r.kind),
    title: str(r.title),
    reason: 'products_deleted',
    droppedProductIds: [],
  }));
  return report;
}

// ---- rendering --------------------------------------------------------------

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '–';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderKnowledgeScopeReport(report: KnowledgeScopeReport): string {
  const out: string[] = [];
  out.push(`# KL-05 knowledge scope report (${report.shape === 'pre_kl05' ? 'before the migration' : 'after the migration'})`);
  out.push('');
  out.push(`Generated ${report.generatedAt}. Read-only.${report.workspaceIds ? ` Workspaces: ${report.workspaceIds.join(', ')}.` : ' All workspaces.'}`);
  out.push('');
  out.push('## Counts');
  out.push('');
  out.push('| Count | Value |');
  out.push('| --- | ---: |');
  for (const [k, v] of Object.entries(report.counts)) out.push(`| ${k} | ${v} |`);
  for (const [k, v] of Object.entries(report.sourcesByKind)) out.push(`| sources of kind ${k} | ${v} |`);
  out.push('');

  if (report.shape === 'pre_kl05') {
    out.push('## Owner review: documents that become available to every product');
    out.push('');
    out.push(
      'Each document below has workspace-wide (document-level) chunks and no source with products ticked, so every product\'s drafts read it today. The migration turns each into ONE knowledge source available to every product, keeping its chunks. For each one, confirm it, or after the deploy either archive the document (excluded at once; restore brings it back) or tick products on its knowledge source (no re-index).',
    );
    out.push('');
    if (report.becomesWorkspaceWide.length === 0) {
      out.push('_None._');
    } else {
      out.push('| Workspace | Document | Name | File | Status | Chunks | Uploaded | Unscoped sources already wrapping it |');
      out.push('| --- | ---: | --- | --- | --- | ---: | --- | --- |');
      for (const d of report.becomesWorkspaceWide) {
        out.push(
          `| ${cell(d.workspaceName ? `${d.workspaceId} ${d.workspaceName}` : d.workspaceId)} | ${d.documentId} | ${cell(d.name)} | ${cell(d.filename)} | ${d.status} | ${d.chunks} | ${d.createdAt.slice(0, 10)} | ${cell(d.unscopedSourceIds.join(', '))} |`,
        );
      }
    }
    out.push('');
    out.push('## Deleted: shadowed document-level chunks (the I039 leak)');
    out.push('');
    out.push('These documents have a source with products ticked; their second, workspace-wide chunk set is deleted before anything is converted.');
    out.push('');
    if (report.shadowed.length === 0) {
      out.push('_None._');
    } else {
      out.push('| Workspace | Document | Name | Chunks deleted | Product-scoped sources |');
      out.push('| --- | ---: | --- | ---: | --- |');
      for (const d of report.shadowed) {
        out.push(`| ${d.workspaceId} | ${d.documentId} | ${cell(d.name)} | ${d.chunks} | ${cell(d.productSourceIds.join(', '))} |`);
      }
    }
    out.push('');
    if (report.partiallyDropped.length > 0) {
      out.push('## Product ids dropped from sources that keep other products');
      out.push('');
      out.push('| Workspace | Source | Kept | Dropped (another tenant\'s or deleted) |');
      out.push('| --- | ---: | --- | --- |');
      for (const s of report.partiallyDropped) {
        out.push(`| ${s.workspaceId} | ${s.sourceId} | ${s.keptProductIds.join(', ')} | ${s.droppedProductIds.join(', ')} |`);
      }
      out.push('');
    }
    if ((report.counts.guardBlockingChunks ?? 0) > 0) {
      out.push(
        `**Blocker:** ${report.counts.guardBlockingChunks} document-level chunk(s) belong to a document of another workspace. The migration's guard will abort the deploy; investigate before deploying.`,
      );
      out.push('');
    }
  } else {
    out.push('## Sources the migration created (available to every product unless changed since)');
    out.push('');
    if (report.migratedSources.length === 0) {
      out.push('_None._');
    } else {
      out.push('| Workspace | Source | Document | Title | Scope now | Document status | Chunks moved |');
      out.push('| --- | ---: | ---: | --- | --- | --- | ---: |');
      for (const s of report.migratedSources) {
        out.push(
          `| ${s.workspaceId} | ${s.sourceId} | ${cell(s.documentId)} | ${cell(s.title)} | ${s.scope} | ${cell(s.documentStatus)} | ${s.chunksAtMigration} |`,
        );
      }
    }
    out.push('');
    if ((report.counts.chunksWithoutSource ?? 0) > 0) {
      out.push(`**Invariant broken:** ${report.counts.chunksWithoutSource} chunk(s) have no knowledge source.`);
      out.push('');
    }
  }

  out.push('## Needs a scope (retrieved nowhere until products are ticked, or none to make it available to every product)');
  out.push('');
  if (report.needsScope.length === 0) {
    out.push('_None._');
  } else {
    out.push('| Workspace | Source | Kind | Title | Why | Dropped product ids |');
    out.push('| --- | ---: | --- | --- | --- | --- |');
    for (const s of report.needsScope) {
      out.push(
        `| ${cell(s.workspaceName ? `${s.workspaceId} ${s.workspaceName}` : s.workspaceId)} | ${s.sourceId} | ${s.kind} | ${cell(s.title)} | ${s.reason.replace(/_/g, ' ')} | ${cell(s.droppedProductIds.join(', '))} |`,
      );
    }
  }
  out.push('');
  return out.join('\n');
}
