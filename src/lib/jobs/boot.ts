// PC-07: this process's boot identity. The tick schedule registration
// stamps `boot_id` on job_heartbeats, and readiness grants a deploy grace
// counted from the boot.
//
// Kept on globalThis, not in a module variable: Next.js compiles the
// instrumentation hook and the route handlers into separate bundles, each
// with its own copy of this module, and both must see ONE boot per process.

import { randomUUID } from 'node:crypto';

export interface BootInfo {
  readonly id: string;
  readonly startedAt: Date;
}

const holder = globalThis as unknown as { __leadPlatformBoot?: BootInfo };

/** The current process's boot. The first call fixes it; call it at startup
 *  (instrumentation) so `startedAt` is the boot, not the first probe. */
export function getBootInfo(): BootInfo {
  if (!holder.__leadPlatformBoot) {
    holder.__leadPlatformBoot = Object.freeze({ id: randomUUID(), startedAt: new Date() });
  }
  return holder.__leadPlatformBoot;
}

/** For tests: pin (or with null, reset) the boot identity. */
export function _setBootInfoForTests(info: BootInfo | null): void {
  if (info) holder.__leadPlatformBoot = info;
  else delete holder.__leadPlatformBoot;
}
