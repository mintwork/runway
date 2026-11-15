// The MicroVM memory quota, read with its unit (Service Quotas reports it in gigabytes).
import {
  ListServiceQuotasCommand,
  type ServiceQuota,
  ServiceQuotasClient,
} from '@aws-sdk/client-service-quotas';

const TO_GB: Record<string, number> = { Gigabytes: 1, Megabytes: 1 / 1024, Terabytes: 1024 };

export interface MicrovmQuota {
  arch: 'arm64' | 'x64';
  gb: number;
}

/** GB of MicroVM memory per architecture, from the quota's value and unit. */
export function microvmQuotas(quotas: ServiceQuota[]): MicrovmQuota[] {
  const out: MicrovmQuota[] = [];
  for (const [arch, name] of [
    ['arm64', 'Max allocated ARM_64 MicroVM memory'],
    ['x64', 'Max allocated X86_64 MicroVM memory'],
  ] as const) {
    const q = quotas.find((x) => x.QuotaName === name);
    if (q?.Value === undefined) continue;
    out.push({ arch, gb: q.Value * (TO_GB[q.Unit ?? 'Gigabytes'] ?? 1) });
  }
  return out;
}

/** How many MicroVMs of `cpu` baseline vCPUs (2 GB each) fit at once. */
export const concurrentMicrovms = (gb: number, cpu: number) => Math.floor(gb / (cpu * 2));

export async function readMicrovmQuotas(region: string): Promise<MicrovmQuota[]> {
  const res = await new ServiceQuotasClient({ region }).send(
    new ListServiceQuotasCommand({ ServiceCode: 'lambda', MaxResults: 100 }),
  );
  return microvmQuotas(res.Quotas ?? []);
}
