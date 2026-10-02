// The autopilot run's steps, in the order runOnce() executes them
// (services/autopilot.ts), each with the switch that enables it (AP-03).
// The assistant handbook prints its step list from here; a test runs
// autopilot with every switch on and checks the recorded order against
// this list, so the guide cannot drift from the run. Type-only imports,
// so the handbook export script can load it without a database.

import type { AutopilotSettings } from '@/lib/db/schema/autopilot';

export interface AutopilotStep {
  /** The step name recorded on autopilot_log. */
  id:
    | 'auto_sync_inbound'
    | 'auto_approve_projects'
    | 'auto_enqueue_outreach'
    | 'auto_drain_queue'
    | 'auto_crm_contact_sync'
    | 'auto_crm_deal_on_qualified';
  /** The autopilot_settings switch that turns the step on. */
  setting: Extract<keyof AutopilotSettings, `enable${string}`>;
  /** How the guide names it. */
  label: string;
}

export const AUTOPILOT_STEPS: ReadonlyArray<AutopilotStep> = [
  { id: 'auto_sync_inbound', setting: 'enableAutoSyncInbound', label: 'Sync inbound mail' },
  { id: 'auto_approve_projects', setting: 'enableAutoApproveProjects', label: 'Auto-approve' },
  {
    id: 'auto_enqueue_outreach',
    setting: 'enableAutoEnqueueOutreach',
    label: 'Generate + enqueue',
  },
  { id: 'auto_drain_queue', setting: 'enableAutoDrainQueue', label: 'Auto-drain the send queue' },
  { id: 'auto_crm_contact_sync', setting: 'enableAutoCrmContactSync', label: 'CRM contact sync' },
  {
    id: 'auto_crm_deal_on_qualified',
    setting: 'enableAutoCrmDealOnQualified',
    label: 'CRM deal on qualified',
  },
];

export type AutopilotStepId = AutopilotStep['id'];
