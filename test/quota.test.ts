import { describe, expect, it } from 'vitest';
import { concurrentMicrovms, microvmQuotas } from '../src/cli/quota.js';

describe('microvmQuotas', () => {
  it('reads the quota in its unit (Service Quotas reports gigabytes)', () => {
    const q = microvmQuotas([
      { QuotaName: 'Max allocated ARM_64 MicroVM memory', Value: 2048, Unit: 'Gigabytes' },
      { QuotaName: 'Max allocated X86_64 MicroVM memory', Value: 2048, Unit: 'Megabytes' },
      { QuotaName: 'Rate of RunMicrovm API requests', Value: 5 },
    ]);
    expect(q).toEqual([
      { arch: 'arm64', gb: 2048 },
      { arch: 'x64', gb: 2 },
    ]);
  });

  it('counts 2 GB of baseline memory per vCPU', () => {
    expect(concurrentMicrovms(2048, 1)).toBe(1024);
    expect(concurrentMicrovms(2048, 4)).toBe(256);
    expect(concurrentMicrovms(2, 1)).toBe(1);
  });
});
