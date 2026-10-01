// Guard: never hand postgres.js a raw JS Date.
//
// drizzle-orm's postgres-js driver swaps postgres.js's timestamptz
// serializer (OID 1184) for a pass-through, because drizzle encodes Dates
// itself through the column they are compared with (mapToDriverValue
// turns them into ISO strings). A Date that reaches the driver without a
// column stays a Date: postgres.js types it 1184, the pass-through returns
// it unchanged, and writing it to the wire throws "The "string" argument
// must be of type string ... Received an instance of Date". Two shapes do
// that:
//
//   1. a Date interpolated into a raw sql`` template
//        sql`${auditLog.createdAt} >= ${filter.since}`
//      (/admin/audit returned a server error whenever Since or Until was
//      set: audit finding I050, deliverable PC-01);
//   2. a drizzle comparison whose left side is an SQL expression, not a
//      column, so nothing encodes the right side
//        gte(sql`coalesce(${a}, ${b})`, since)
//
// Safe forms: compare against the column itself (gte(col, since)); pass
// an ISO string with a cast (sql`${col} >= ${since.toISOString()}::timestamptz`);
// or bind through the column (sql.param(since, col)).
//
// This test type-checks src/ and scripts/ with the TypeScript compiler
// and fails on either shape when the bound value's type includes Date
// (Date, Date | undefined, Date[], a type parameter constrained to Date).
// A value typed any or unknown cannot be proven safe, so it fails too
// when its name reads like a timestamp (since, until, cutoff, createdAt,
// sent_at, ...). Fix a failure with one of the safe forms above.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIRS = ['src', 'scripts'];

/**
 * Vetted bindings the guard lets through, matched on repo-relative file
 * and the exact source text of the bound expression. ISO strings with a
 * ::timestamptz cast never need an entry: they are typed string, so the
 * guard never flags them. Add one only for a value the checker sees as
 * Date / any / unknown that you have shown is encoded before it reaches
 * the driver, and say how in `reason`.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; expression: string; reason: string }> = [];

/** drizzle-orm condition builders that encode their values through the left operand. */
const COMPARISONS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'notBetween',
  'inArray',
  'notInArray',
]);

/** Names that read like a timestamp, for values typed any / unknown. */
const TIMESTAMP_NAME = /[Dd]ate|[Tt]ime|[Ss]ince|[Uu]ntil|[Cc]utoff|[Dd]eadline|(At|_at)$/;

// Fixtures for the guard's self-checks. They are compiled in the same
// program as the repo (so drizzle and the schema resolve for real) but
// live only in memory and are never part of the repo scan.
const FIXTURE_DIR = toPosix(path.join(repoRoot, 'src', '__sql_date_guard_fixtures__'));

const UNSAFE_FIXTURE = `${FIXTURE_DIR}/unsafe.ts`;
const SAFE_FIXTURE = `${FIXTURE_DIR}/safe.ts`;

const FIXTURES: Record<string, string> = {
  [UNSAFE_FIXTURE]: `
    import { between, gte, inArray, sql } from 'drizzle-orm';
    import { auditLog } from '@/lib/db/schema/audit';

    interface Filter {
      since?: Date;
      until?: Date;
    }

    export function templates<T extends Date>(
      filter: Filter,
      cutoff: Date,
      days: Date[],
      bound: T,
      row: any,
      payload: unknown,
    ) {
      const conds: unknown[] = [];
      // The exact shape that broke /admin/audit (I050).
      if (filter.since) conds.push(sql\`\${auditLog.createdAt} >= \${filter.since}\`);
      conds.push(sql<number>\`count(*) filter (where \${auditLog.createdAt} < \${cutoff})\`);
      conds.push(sql\`\${auditLog.createdAt} < \${new Date()}\`);
      conds.push(sql\`\${auditLog.createdAt} = any(\${days})\`);
      conds.push(sql\`\${auditLog.createdAt} <= \${bound}\`);
      conds.push(sql\`\${auditLog.createdAt} > \${row.updatedAt}\`);
      conds.push(sql\`\${auditLog.createdAt} > \${(payload as any).sent_at}\`);
      return conds;
    }

    export function comparisons(start: Date, end: Date, days: Date[]) {
      const day = sql<Date>\`date_trunc('day', \${auditLog.createdAt})\`;
      return [
        gte(sql\`coalesce(\${auditLog.createdAt}, now())\`, start),
        between(day, start, end),
        inArray(day, days),
      ];
    }
  `,
  [SAFE_FIXTURE]: `
    import { and, between, gte, inArray, lt, sql } from 'drizzle-orm';
    import { auditLog } from '@/lib/db/schema/audit';

    export function safe(since: Date, until: Date, days: Date[], sinceIso: string, row: any) {
      return [
        and(gte(auditLog.createdAt, since), lt(auditLog.createdAt, until)),
        between(auditLog.createdAt, since, until),
        inArray(auditLog.createdAt, days),
        sql\`\${auditLog.createdAt} >= \${since.toISOString()}::timestamptz\`,
        sql\`\${auditLog.createdAt} >= \${sinceIso}::timestamptz\`,
        sql\`\${auditLog.createdAt} >= \${sql.param(since, auditLog.createdAt)}\`,
        sql\`extract(epoch from \${auditLog.createdAt}) > \${since.getTime() / 1000}\`,
        sql\`\${auditLog.kind} = \${row.kind}\`,
      ];
    }
  `,
};

interface Finding {
  file: string;
  line: number;
  shape: 'sql template' | 'comparison';
  expression: string;
  type: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function relativeToRepo(fileName: string): string {
  return toPosix(path.relative(repoRoot, fileName));
}

function isScanned(fileName: string): boolean {
  const posix = toPosix(fileName);
  if (posix.startsWith(`${FIXTURE_DIR}/`)) return false;
  const rel = relativeToRepo(fileName);
  return SCAN_DIRS.some((dir) => rel.startsWith(`${dir}/`)) && !rel.includes('node_modules/');
}

/** One program over the repo's src/ and scripts/ plus the in-memory fixtures. */
function createProgram(): ts.Program {
  const configFile = ts.readConfigFile(path.join(repoRoot, 'tsconfig.json'), ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    incremental: false,
    tsBuildInfoFile: undefined,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  const fixture = (fileName: string): string | undefined => FIXTURES[toPosix(fileName)];
  const readSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = fixture(fileName);
    return text === undefined
      ? readSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fixture(fileName) !== undefined || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => fixture(fileName) ?? readFile(fileName);
  return ts.createProgram({
    rootNames: [...parsed.fileNames.filter(isScanned), ...Object.keys(FIXTURES)],
    options,
    host,
  });
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The name an expression reads as: `since`, `filter.until` → `until`, `row['sent_at']` → `sent_at`. */
function readableName(expr: ts.Expression): string {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  if (ts.isCallExpression(e)) return readableName(e.expression);
  return '';
}

function containsDate(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => containsDate(checker, t, seen));
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && containsDate(checker, constraint, seen);
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker
      .getTypeArguments(type as ts.TypeReference)
      .some((t) => containsDate(checker, t, seen));
  }
  return type.getSymbol()?.getName() === 'Date';
}

/** True when the value bound for `expr` could be a Date the driver cannot encode. */
function mayBeDate(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(expr);
  if (containsDate(checker, type)) return true;
  const untyped = (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  return untyped && TIMESTAMP_NAME.test(readableName(expr));
}

function isDrizzleCondition(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression) || !COMPARISONS.has(call.expression.text)) return false;
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (
    symbol?.declarations?.some((d) =>
      toPosix(d.getSourceFile().fileName).includes('/drizzle-orm/'),
    ) ?? false
  );
}

/** Columns (and anything else with mapToDriverValue) encode the values compared with them. */
function encodesValues(checker: ts.TypeChecker, left: ts.Expression): boolean {
  return checker.getPropertyOfType(checker.getTypeAtLocation(left), 'mapToDriverValue') !== undefined;
}

function scanFile(checker: ts.TypeChecker, sf: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const report = (shape: Finding['shape'], expr: ts.Expression): void => {
    const { line } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
    findings.push({
      file: relativeToRepo(sf.fileName),
      line: line + 1,
      shape,
      expression: expr.getText(sf),
      type: checker.typeToString(checker.getTypeAtLocation(expr)),
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'sql' &&
      ts.isTemplateExpression(node.template)
    ) {
      for (const span of node.template.templateSpans) {
        if (mayBeDate(checker, span.expression)) report('sql template', span.expression);
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && isDrizzleCondition(checker, node)) {
      const [left, ...values] = node.arguments;
      if (left && !encodesValues(checker, left)) {
        for (const value of values) {
          if (mayBeDate(checker, value)) report('comparison', value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function scan(program: ts.Program, include: (fileName: string) => boolean): Finding[] {
  const checker = program.getTypeChecker();
  return program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && include(sf.fileName))
    .flatMap((sf) => scanFile(checker, sf));
}

function isAllowlisted(f: Finding): boolean {
  return ALLOWLIST.some((a) => a.file === f.file && a.expression === f.expression);
}

function describeFinding(f: Finding): string {
  return `${f.file}:${f.line} ${f.shape} binds \${${f.expression}} (${f.type})`;
}

let program: ts.Program;
let repoFindings: Finding[];

beforeAll(() => {
  program = createProgram();
  repoFindings = scan(program, isScanned);
}, 180_000);

describe('raw Date bindings (postgres.js cannot encode them)', () => {
  it('appear nowhere in src/ or scripts/', () => {
    const offending = repoFindings.filter((f) => !isAllowlisted(f)).map(describeFinding);
    expect(offending).toEqual([]);
  });

  it('keeps every allowlist entry in use', () => {
    const stale = ALLOWLIST.filter(
      (a) => !repoFindings.some((f) => f.file === a.file && f.expression === a.expression),
    );
    expect(stale).toEqual([]);
  });

  describe('self-check', () => {
    // So a regression in the scanner cannot make the repo check above
    // pass vacuously. The fixtures must compile cleanly, or a missing
    // import would type everything `any` and hide what is being tested.
    it('compiles the fixtures without errors', () => {
      const errors = Object.keys(FIXTURES).flatMap((file) => {
        const sf = program.getSourceFile(file);
        if (!sf) return [`${file} is not in the program`];
        return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map(
          (d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        );
      });
      expect(errors).toEqual([]);
    });

    it('flags Dates interpolated into sql templates, including the /admin/audit shape', () => {
      const found = scan(program, (f) => toPosix(f) === UNSAFE_FIXTURE).filter(
        (f) => f.shape === 'sql template',
      );
      expect(found.map((f) => f.expression)).toEqual([
        'filter.since',
        'cutoff',
        'new Date()',
        'days',
        'bound',
        'row.updatedAt',
        '(payload as any).sent_at',
      ]);
    });

    it('flags Dates compared against an SQL expression instead of a column', () => {
      const found = scan(program, (f) => toPosix(f) === UNSAFE_FIXTURE).filter(
        (f) => f.shape === 'comparison',
      );
      expect(found.map((f) => f.expression)).toEqual(['start', 'start', 'end', 'days']);
    });

    it('lets the safe forms through: column comparisons, ISO strings with ::timestamptz, sql.param', () => {
      expect(scan(program, (f) => toPosix(f) === SAFE_FIXTURE).map(describeFinding)).toEqual([]);
    });
  });
});
