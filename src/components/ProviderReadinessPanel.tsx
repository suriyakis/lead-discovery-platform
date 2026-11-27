// Settings → AI & search: will each job run, and on whose API key? One row
// per job, answered by getProviderReadiness
// (src/lib/services/provider-readiness.ts) with the runtime's own cascades
// — so "runs on the platform key" here means a call made now really uses
// the platform key, whether the platform admin saved it in the console or
// in the server env. Server components (no hooks).

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert } from '@/components/Alert';
import { Badge, StatusBadge } from '@/components/Badge';
import { BRAND_NAME } from '@/lib/brand';
import {
  platformKeyBilling,
  vendorDisplayName,
  vendorKeyGap,
  vendorUses,
  type JobId,
  type JobReadiness,
  type PlatformKeyBilling,
  type ProviderReadiness,
  type VendorKeyGap,
} from '@/lib/services/provider-readiness';
import styles from './ProviderReadinessPanel.module.css';

/** Vendors with a key section on /settings/integrations, where an admin
 *  can save the workspace's own key. DeepSeek and Mistral have none. */
export const KEY_SECTION_VENDORS: ReadonlySet<string> = new Set([
  'serpapi',
  'openai',
  'anthropic',
  'gemini',
  'perplexity',
]);

/** Jobs where choosing another provider in Active providers can stand in
 *  for a vendor whose key is missing. Not knowledge retrieval: every
 *  embedding and vector-storage option needs the OpenAI key
 *  (ALLOWED_EMBEDDING_PROVIDERS is openai only; pgvector embeds with it,
 *  the OpenAI vector store is OpenAI). Not reading scanned PDFs: always
 *  Mistral. A job with no real provider at all (not_set_up, the mock) can
 *  always be given one there — every job but OCR has a choice. */
const PICKABLE_JOBS: ReadonlySet<JobId> = new Set([
  'discovery',
  'qualification',
  'research',
  'first_emails',
  'replies',
  'drafting',
]);

/** Who is reading, and what they can change. */
interface Reader {
  /** Simple setup: the workspace cannot pick providers or add keys. */
  simple: boolean;
  isAdmin: boolean;
  /** The plan allows the workspace's own keys (BYOK). */
  byokAllowed: boolean;
}

const formatTokens = (n: bigint) => n.toLocaleString('en-GB');
const listLabels = (labels: readonly string[]) =>
  new Intl.ListFormat('en', { style: 'long', type: 'unit' }).format(labels);
const listJobs = (jobs: readonly JobReadiness[]) => listLabels(jobs.map((j) => j.label));
/** "A, B and C": for the few named exceptions to a statement. */
const listAnd = (labels: readonly string[]) =>
  new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(labels);

function supportLink(text: string): ReactNode {
  return <Link href="/support">{text}</Link>;
}

/** What the reader can do about a job that will not run, or runs on
 *  keyword rules only — never an option their setup or plan rules out. */
function remedy(job: JobReadiness, r: Reader): ReactNode {
  const article = /^[aeiou]/i.test(job.vendorName) ? 'an' : 'a';
  const missing =
    job.state === 'not_set_up' ? 'a provider for this job' : `${article} ${job.vendorName} key`;
  if (r.simple) {
    return (
      <>
        {BRAND_NAME} needs to set up {missing} — {supportLink('contact support')}.
      </>
    );
  }
  if (job.state === 'not_set_up') {
    // Only the mock is not set up, and every such job has a choice in
    // Active providers.
    return r.isAdmin ? (
      <>Pick a provider in Active providers below, or {supportLink('contact support')}.</>
    ) : (
      <>Ask a workspace admin to pick a provider.</>
    );
  }
  const pick = PICKABLE_JOBS.has(job.job);
  if (!r.isAdmin) {
    return pick ? (
      <>Ask a workspace admin to pick another provider or get {missing}.</>
    ) : (
      <>
        Ask a workspace admin or {supportLink(`${BRAND_NAME} support`)} for {missing}.
      </>
    );
  }
  const section = KEY_SECTION_VENDORS.has(job.vendor);
  if (section && r.byokAllowed) {
    return (
      <>
        Add your own {job.vendorName} key in its section below
        {pick ? ', pick another provider' : ''}, or {supportLink(`ask ${BRAND_NAME} support`)} for
        a platform key.
      </>
    );
  }
  return (
    <>
      {pick ? 'Pick another provider, or ' : ''}
      {supportLink(`${pick ? 'ask' : 'Ask'} ${BRAND_NAME} support`)} for a platform key.
      {section ? ' Your own keys need the Pro plan.' : ''}
    </>
  );
}

/** "the Research panel …" → "The Research panel …". */
const sentenceCase = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

function keySentence(job: JobReadiness, wallet: ProviderReadiness['wallet'], r: Reader): ReactNode {
  const vendor = job.vendorName;
  switch (job.state) {
    case 'ready': {
      // A job whose entry points never check the wallet is ready on an
      // empty one (WALLET_GATED in provider-readiness.ts): say it runs —
      // or, when part of it is gated (gatedPart), which part runs and
      // which pauses. The paused part is not promised back "until tokens
      // are added": the work it pauses with may lack a key as well.
      const stillRuns = wallet.empty && !job.walletGated;
      const runs = job.gatedPart ? sentenceCase(job.gatedPart.running) : 'It';
      const pausedPart = job.gatedPart
        ? ` ${sentenceCase(job.gatedPart.paused)} while the token balance is empty.`
        : '';
      if (job.key === 'workspace') {
        return `Runs on your own ${vendor} key. ${vendor} bills your account directly; your token balance is not charged.${stillRuns ? ` ${runs} still runs while the token balance is empty.${pausedPart}` : ''}`;
      }
      let billing = '';
      if (stillRuns) {
        billing = job.billedFromTokens
          ? ` ${runs} still runs while the token balance is empty, and its usage is still deducted, so the balance can go below zero.${pausedPart}`
          : ` ${runs} still runs while the token balance is empty.${pausedPart}`;
      } else if (job.billedFromTokens) {
        billing = wallet.billingExempt
          ? ' This workspace is not charged for usage.'
          : ` Usage is paid from your token balance (${formatTokens(wallet.balance)} tokens left).`;
      }
      return `Runs on ${BRAND_NAME}'s ${vendor} key — the platform provides it, you don't need a key of your own.${billing}`;
    }
    case 'rules_only':
      // Keyword-rules scoring runs behind the same wallet gate (inside a
      // discovery run, or Re-classify all): on an empty wallet it pauses.
      return (
        <>
          There is no {vendor} key, so each company is scored with keyword rules only — AI
          scoring is off until a key is added. {remedy(job, r)}
          {wallet.empty && job.walletGated
            ? ' The token balance is empty too, so this job pauses until tokens are added.'
            : ''}
        </>
      );
    case 'no_key':
      return (
        <>
          There is no {vendor} key — neither the platform nor this workspace has one,{' '}
          {job.noKeyEffect}. {remedy(job, r)}
        </>
      );
    case 'not_set_up':
      return (
        <>
          No real provider is set up, so this job would only produce sample data. {remedy(job, r)}
        </>
      );
    case 'no_tokens': {
      const ready = `${job.key === 'workspace' ? `Your own ${vendor} key is ready` : `${BRAND_NAME}'s ${vendor} key is ready`}, but the token balance is empty, so this job pauses until tokens are added.`;
      // Work on this provider whose entry points check no wallet — and,
      // in the note, where the same controls do need tokens.
      const part = job.ungatedPart;
      if (!part) return ready;
      // Platform-paid work (send-time translation) is never deducted; on
      // the workspace's own key its vendor bills it, as the sentence says.
      const debit = part.billedFromTokens
        ? ` — and ${part.parts.length > 1 ? 'their' : 'its'} usage is still deducted, so the balance can go below zero`
        : part.platformPaid && job.key === 'platform'
          ? ` — ${BRAND_NAME} pays for ${part.parts.length > 1 ? 'them' : 'it'}, so nothing is deducted`
          : '';
      const note = part.note ? ` ${sentenceCase(part.note)}.` : '';
      return `${ready} Still running: ${part.detail}${debit}.${note}`;
    }
  }
}

/** Something that still runs on an empty wallet, and whether its usage
 *  is still deducted. */
interface StillRunning {
  label: string;
  deducted: boolean;
  /** The label names more than one thing ("some translation and …"). */
  plural: boolean;
}

/**
 * What still runs on an empty wallet: the ungated jobs (only the part
 * that runs, when part of one is gated — WALLET_GATED_PARTS), the
 * ungated features that have a key, and the ungated part of a paused job
 * (WALLET_UNGATED_PARTS) — deducted when it runs on a platform key whose
 * usage is debited.
 */
function stillRunning(readiness: ProviderReadiness): StillRunning[] {
  const items: StillRunning[] = [];
  for (const j of readiness.jobs) {
    if (j.state === 'ready' && !j.walletGated) {
      items.push({
        label: j.gatedPart?.running ?? j.label,
        deducted: j.billedFromTokens,
        plural: false,
      });
    }
  }
  for (const f of readiness.features) {
    const keyed = f.vendors.filter((v) => v.hasKey);
    if (f.walletGated || keyed.length === 0) continue;
    items.push({
      label: f.label,
      deducted: f.platformKeyDebited && keyed.some((v) => v.key === 'platform'),
      plural: false,
    });
  }
  for (const j of readiness.jobs) {
    if (j.state === 'no_tokens' && j.ungatedPart) {
      items.push({
        label: j.ungatedPart.short,
        deducted: j.ungatedPart.billedFromTokens,
        plural: j.ungatedPart.parts.length > 1,
      });
    }
  }
  return items;
}

/**
 * The empty-wallet alert's body: what pauses, and what still runs.
 * `waiting` is every job the empty wallet pauses (pausedForTokens); when
 * none is, each job that checks the wallet (WALLET_GATED) is stopped for
 * a key or a provider already, and the key alert counts it — so this
 * names those jobs, not "the jobs that use tokens": the ungated ones use
 * tokens too, and still run.
 */
function emptyWalletSummary(waiting: JobReadiness[], readiness: ProviderReadiness): string {
  let paused: string;
  if (waiting.length > 0) {
    paused = `${listJobs(waiting)} ${waiting.length === 1 ? 'pauses' : 'pause'} until tokens are added.`;
  } else {
    const gated = readiness.jobs.filter((j) => j.walletGated);
    const one = gated.length === 1;
    paused = `${listJobs(gated)} ${one ? 'needs' : 'need'} a key or a provider first (see ${one ? 'its row' : 'their rows'}); once ${one ? 'it has' : 'they have'} one, ${one ? 'it pauses' : 'they pause'} until tokens are added.`;
  }
  const running = stillRunning(readiness);
  if (running.length === 0) return paused;
  const many = running.length > 1 || running[0]!.plural;
  // Name what is NOT deducted, as the billing clause does.
  const free = running.filter((i) => !i.deducted);
  const debit =
    free.length === running.length
      ? ''
      : `, and ${many ? 'their' : 'its'} usage is still deducted${free.length > 0 ? ` (except ${listAnd(free.map((i) => i.label))})` : ''}, so the balance can go below zero`;
  // A job label is capitalised already; a part ("some translation …") is not.
  const list = sentenceCase(listAnd(running.map((i) => i.label)));
  return `${paused} ${list} still ${many ? 'run' : 'runs'}${debit}.`;
}

/** "Qualification runs on keyword rules only." — or, when the empty
 *  wallet pauses it as well (it is in `waiting`), that it would. Never
 *  "runs" for a job the wallet alert lists as paused. */
function rulesOnlySentence(degraded: JobReadiness[], waiting: JobReadiness[]): string {
  const running = degraded.filter((j) => !waiting.includes(j));
  const paused = degraded.filter((j) => waiting.includes(j));
  const out: string[] = [];
  if (running.length > 0) {
    out.push(`${listJobs(running)} ${running.length === 1 ? 'runs' : 'run'} on keyword rules only.`);
  }
  if (paused.length > 0) {
    const one = paused.length === 1;
    out.push(
      `${listJobs(paused)} ${one ? 'has' : 'have'} no key, so ${one ? 'it' : 'they'} would score with keyword rules only — and the empty token balance pauses ${one ? 'it' : 'them'} too.`,
    );
  }
  return out.join(' ');
}

export function ProviderReadinessPanel({
  readiness,
  simple,
  isAdmin,
  byokAllowed,
}: Readonly<{
  readiness: ProviderReadiness;
  simple: boolean;
  isAdmin: boolean;
  byokAllowed: boolean;
}>) {
  const reader: Reader = { simple, isAdmin, byokAllowed };
  const { jobs, wallet, allReady } = readiness;
  const failing = jobs.filter((j) => j.state === 'no_key' || j.state === 'not_set_up');
  const degraded = jobs.filter((j) => j.state === 'rules_only');
  // What the empty wallet pauses: the no_tokens jobs, and a gated job on
  // keyword rules only (its scoring sits behind the same wallet gate). A
  // job with no key or provider is counted once, in the key alert.
  const waiting = wallet.empty
    ? jobs.filter((j) => j.state === 'no_tokens' || (j.state === 'rules_only' && j.walletGated))
    : [];

  // Two independent answers, each shown whenever it applies: what a
  // missing key or provider does (one alert, by severity), and what the
  // empty wallet pauses — so neither hides the other.
  let keyAlert: ReactNode = null;
  if (allReady) {
    keyAlert = (
      <Alert tone="success" title="Everything is ready to run">
        <p>
          Every job below has a provider and a key to run on.
          {!simple && isAdmin
            ? ' This page checks that each key is saved, not that the provider accepts it — a revoked key shows as ready until a call fails.'
            : ''}
        </p>
      </Alert>
    );
  } else if (failing.length > 0) {
    const missing = failing.every((j) => j.state === 'no_key')
      ? 'a key'
      : failing.every((j) => j.state === 'not_set_up')
        ? 'a provider'
        : 'a key or a provider';
    keyAlert = (
      <Alert
        tone="danger"
        title={`${failing.length === 1 ? '1 job' : `${failing.length} jobs`} will not run without ${missing}`}
      >
        <p>
          {listJobs(failing)} — see the reason on each row below.
          {degraded.length > 0 ? ` ${rulesOnlySentence(degraded, waiting)}` : ''}
          {waiting.length > 0
            ? ` Not counted here: ${waiting.length === 1 ? 'the job' : `the ${waiting.length} jobs`} paused because the token balance is empty.`
            : ''}
        </p>
      </Alert>
    );
  } else if (degraded.length > 0) {
    // On an empty wallet a gated keyword-rules job is paused too (it is in
    // `waiting`): the title names the key gap, never that it "runs".
    const anyPaused = degraded.some((j) => waiting.includes(j));
    const one = degraded.length === 1;
    keyAlert = (
      <Alert
        tone="warning"
        title={
          anyPaused
            ? `${listJobs(degraded)} ${one ? 'has' : 'have'} no key for AI scoring`
            : `${listJobs(degraded)} ${one ? 'runs' : 'run'} on keyword rules only`
        }
      >
        <p>
          {anyPaused
            ? `${rulesOnlySentence(degraded, waiting)} See the row below.`
            : 'AI scoring is off until a key is added — see the row below.'}
        </p>
      </Alert>
    );
  }

  const walletAlert: ReactNode = wallet.empty ? (
    <Alert
      tone="warning"
      title={
        failing.length === 0 && degraded.length === 0
          ? 'Providers are ready, but the token balance is empty'
          : 'The token balance is empty'
      }
      action={isAdmin ? <Link href="/settings/billing">Buy tokens</Link> : undefined}
    >
      <p>{emptyWalletSummary(waiting, readiness)}</p>
    </Alert>
  ) : null;

  return (
    <section aria-labelledby="provider-readiness-title" className={styles.panel}>
      <h2 id="provider-readiness-title">What runs, and on whose key</h2>
      <p className={styles.note}>
        Each job below needs an AI or search provider with an API key. A job
        uses this workspace&apos;s own key when you have added one, otherwise{' '}
        {BRAND_NAME}&apos;s platform key — the per-provider status further
        down means the same.
      </p>

      {keyAlert}
      {walletAlert}

      <ul className={styles.list}>
        {jobs.map((job) => (
          <li
            key={job.job}
            className={styles.row}
            data-job={job.job}
            data-state={job.state}
            data-key={job.key}
          >
            <div className={styles.head}>
              <StatusBadge set="provider_job_state" value={job.state} />
              <p className={styles.title}>
                {job.label} · {job.vendorName}
              </p>
              {job.model ? (
                <Badge variant="mono" size="sm" title="Model">
                  {job.model}
                </Badge>
              ) : null}
            </div>
            <p className={styles.purpose}>{job.purpose}</p>
            <p className={styles.detail}>{keySentence(job, wallet, reader)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What a missing key stops or limits — the Simple list and NoKeyNote say
 * it the same way. `lead` is one clause ending "until a key is added" (the
 * jobs, else the features); `tail` is a sentence on the features when the
 * jobs led ('' otherwise). Both '' when the key affects nothing.
 */
export function describeKeyGap(gap: VendorKeyGap): { lead: string; tail: string } {
  const jobParts: string[] = [];
  if (gap.stopped.length > 0) jobParts.push(`${listJobs(gap.stopped)} will not run`);
  if (gap.degraded.length > 0) {
    jobParts.push(`${listJobs(gap.degraded)} runs on keyword rules only`);
  }
  const featureParts = gap.features.map((f) =>
    f.fallback ? `${f.label} can still use ${f.fallback} but not ${f.lost}` : `${f.label} will not work`,
  );
  if (jobParts.length > 0) {
    return {
      lead: `${jobParts.join('; ')} until a key is added`,
      tail: featureParts.length > 0 ? `Without it, ${featureParts.join('; ')}.` : '',
    };
  }
  if (featureParts.length > 0) {
    return { lead: `${featureParts.join('; ')} until a key is added`, tail: '' };
  }
  return { lead: '', tail: '' };
}

/**
 * The Simple setup list's line for a vendor, derived from the job rows:
 * what its key is used for now, or what the missing key affects. Null when
 * the badge already says it all ("No key — not needed now").
 */
export function vendorUseSentence(readiness: ProviderReadiness, vendor: string): string | null {
  const gap = vendorKeyGap(readiness, vendor);
  if (gap) {
    if (gap.gap === 'unused') return null;
    const { lead, tail } = describeKeyGap(gap);
    return `${lead}.${tail ? ` ${tail}` : ''}`;
  }
  const uses = vendorUses(readiness, vendor);
  const labels = [...uses.jobs.map((j) => j.label), ...uses.features];
  return labels.length > 0 ? `Used for ${listLabels(labels)}.` : 'Not used by any job now.';
}

/**
 * The effective-key line on a provider section when neither the workspace
 * nor the platform has a key for that vendor. It names the jobs and
 * features the missing key stops or limits — or says it affects none. A
 * bare red "Not configured" on every such vendor was read as "nothing will
 * run" (26 Nov) even when no job used that vendor. Features outside the
 * job rows count too (VENDOR_FEATURES: Suggest with AI on products), so
 * "nothing is affected" is said only when nothing is.
 */
export function NoKeyNote({
  vendor,
  readiness,
  isAdmin,
  byokAllowed,
}: Readonly<{
  vendor: string;
  readiness: ProviderReadiness;
  isAdmin: boolean;
  byokAllowed: boolean;
}>) {
  const name = vendorDisplayName(vendor);
  const gap = vendorKeyGap(readiness, vendor);
  if (!gap) return null;
  if (gap.gap === 'unused') {
    return (
      <>
        <StatusBadge set="provider_key_gap" value="unused" />
        <span className="muted">
          {' '}
          — no job uses {name} now, so nothing is affected. It needs a key before it can be
          chosen as a provider.
        </span>
      </>
    );
  }
  const action: ReactNode = !isAdmin ? (
    'ask a workspace admin to get one'
  ) : byokAllowed && KEY_SECTION_VENDORS.has(vendor) ? (
    <>add a workspace key below, or {supportLink(`ask ${BRAND_NAME} support`)} for a platform key</>
  ) : (
    <>
      {supportLink(`ask ${BRAND_NAME} support`)} for a platform key
      {KEY_SECTION_VENDORS.has(vendor) ? ' (your own keys need the Pro plan)' : ''}
    </>
  );
  const { lead, tail } = describeKeyGap(gap);
  return (
    <>
      <StatusBadge set="provider_key_gap" value={gap.gap} />
      <span className="muted">
        {' '}
        — {lead}: {action}.{tail ? ` ${tail}` : ''}
      </span>
    </>
  );
}

/** The billing clause for a vendor's platform key, or '' to promise
 *  nothing. One wording for the section intro and its key line. */
function billingClause(billing: PlatformKeyBilling): string {
  switch (billing.kind) {
    case 'none':
      return '';
    case 'exempt':
      return 'this workspace is not charged for usage';
    case 'tokens':
      // Name what is NOT charged: everything else on the key is.
      return billing.free.length === 0
        ? 'usage is paid from your token balance'
        : `usage is paid from your token balance, except ${listAnd(billing.free.map((j) => j.label))}, which ${billing.free.length === 1 ? 'is' : 'are'} not charged`;
  }
}

/**
 * A provider section's sentence on whose key it can run on. Offers the
 * workspace's own key only when the plan allows it (BYOK), states the
 * platform key's billing exactly as the key line below does — and never
 * offers the platform key when the platform has none for this vendor.
 */
export function KeyChoiceIntro({
  vendor,
  noun,
  biller,
  readiness,
  byokAllowed,
}: Readonly<{
  vendor: string;
  /** The vendor in a sentence: "its own {noun} key". */
  noun: string;
  /** Who bills the workspace's own key: "{biller} bills that account". */
  biller: string;
  readiness: ProviderReadiness;
  byokAllowed: boolean;
}>) {
  const status = readiness.vendors.find((v) => v.vendor === vendor);
  if (!status) throw new Error(`provider key catalogue has no ${vendor}`);
  const noPlatform = `${BRAND_NAME} has no platform key for ${noun}.`;
  const clause = billingClause(platformKeyBilling(readiness, vendor));
  const platform = `${BRAND_NAME}'s platform key${clause ? ` (${clause})` : ''}`;
  if (byokAllowed) {
    return status.platformKey ? (
      <>
        A workspace can bring its own {noun} key ({biller} bills that account) or run on{' '}
        {platform}.
      </>
    ) : (
      <>
        A workspace can bring its own {noun} key ({biller} bills that account). {noPlatform}
      </>
    );
  }
  if (status.workspaceKey) {
    // Saved while the plan allowed it: resolveProviderKey still prefers it.
    return status.platformKey ? (
      <>
        This workspace&apos;s own {noun} key, saved earlier, still takes precedence over{' '}
        {BRAND_NAME}&apos;s platform key ({biller} bills that account).
      </>
    ) : (
      <>
        This workspace&apos;s own {noun} key, saved earlier, still applies ({biller} bills that
        account). {noPlatform}
      </>
    );
  }
  return status.platformKey ? <>This workspace runs on {platform}.</> : <>{noPlatform}</>;
}

/**
 * A provider section's "Effective key source": the workspace's own key
 * (and what uses it), the platform's (and how it is paid), or no key at
 * all (NoKeyNote).
 */
export function KeySourceLine({
  vendor,
  readiness,
  isAdmin,
  byokAllowed,
  simple = false,
}: Readonly<{
  vendor: string;
  readiness: ProviderReadiness;
  isAdmin: boolean;
  byokAllowed: boolean;
  /** Simple setup: providers are chosen only after switching to Advanced. */
  simple?: boolean;
}>) {
  const status = readiness.vendors.find((v) => v.vendor === vendor);
  if (!status) throw new Error(`provider key catalogue has no ${vendor}`);
  if (status.effective === 'workspace') {
    const uses = vendorUses(readiness, vendor);
    const labels = [...uses.jobs.map((j) => j.label), ...uses.features];
    if (labels.length === 0) {
      // Saved, but every job runs elsewhere: say so, and how to use it.
      const putToUse = !isAdmin
        ? `A workspace admin can put it to use by choosing ${status.name} in Active providers${simple ? ', in Advanced setup' : ''}.`
        : simple
          ? `Switch to Advanced setup and choose ${status.name} in Active providers to use it.`
          : `Choosing ${status.name} in Active providers puts it to use.`;
      return (
        <>
          <StatusBadge set="usage_key_source" value="workspace" />
          <span className="muted">
            {' '}
            — this workspace&apos;s own {status.name} key is saved, but no job uses it now.{' '}
            {putToUse}
          </span>
        </>
      );
    }
    return (
      <>
        <StatusBadge set="usage_key_source" value="workspace" />
        <span className="muted">
          {' '}
          — this workspace&apos;s own {status.name} key is used for {listLabels(labels)};{' '}
          {status.name} bills your account, not your tokens.
        </span>
      </>
    );
  }
  if (status.effective === 'platform') {
    const clause = billingClause(platformKeyBilling(readiness, vendor));
    return (
      <>
        <StatusBadge set="usage_key_source" value="platform" />
        <span className="muted">
          {' '}
          — {BRAND_NAME} provides the key{clause ? `; ${clause}` : ''}.
        </span>
      </>
    );
  }
  return (
    <NoKeyNote vendor={vendor} readiness={readiness} isAdmin={isAdmin} byokAllowed={byokAllowed} />
  );
}
