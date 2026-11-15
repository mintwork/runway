// Scheduled every 2 minutes: ends runners that are no longer needed and machines runway has no
// record of, so a lost webhook can never leave something running (and billing) for long.
import { sweep } from '../core/dispatch.js';
import { log, runtimeDeps } from './runtime.js';

export async function handler(): Promise<void> {
  const result = await sweep(await runtimeDeps());
  if (result.terminated.length || result.orphans.length) log('sweep', { ...result });
}
