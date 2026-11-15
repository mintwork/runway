// Turns a job's `runs-on` labels into the machine to launch.
//
//   runs-on: [runway]                          default compute and size
//   runs-on: [runway, microvm, 2cpu]           Lambda MicroVM, 2 vCPU baseline (bursts to 8)
//   runs-on: [runway, ec2, spot, x64, 8cpu]    EC2 Spot, picks an 8 vCPU instance type
//   runs-on: [runway, c7g.2xlarge, disk-100gb] an exact EC2 instance type
//   runs-on: [runway, fargate, 4cpu, 16gb]     ECS Fargate task
//   runs-on: [runway, lambda, 2cpu]            Lambda function (15 min max, no Docker)
//
// Unknown labels are an error rather than ignored, so a typo like `4cpus` fails loudly
// instead of silently running on the default machine.

export const TRIGGER_LABEL = 'runway';
export const COMPUTES = ['microvm', 'ec2', 'fargate', 'lambda'] as const;
export type Compute = (typeof COMPUTES)[number];
export type Arch = 'arm64' | 'x64';

export interface JobSpec {
  compute: Compute;
  arch: Arch;
  /** vCPUs. For MicroVMs this is the baseline; they burst to 4x. */
  cpu: number;
  /** Memory in GiB. For EC2 without an exact type, the minimum across the candidate types. */
  memoryGb: number;
  /** Root/ephemeral disk in GiB, when the compute type lets you choose. */
  diskGb?: number;
  /** EC2 only: candidate instance types, best first. */
  instanceTypes?: string[];
  /** EC2 only: try Spot first (falls back to on-demand). */
  spot: boolean;
}

export interface LabelDefaults {
  compute: Compute;
}

export type ParseResult = { ok: true; spec: JobSpec } | { ok: false; error: string };

const IGNORED = new Set(['self-hosted', 'linux', TRIGGER_LABEL]);
const ARCH_ALIASES: Record<string, Arch> = {
  arm64: 'arm64',
  aarch64: 'arm64',
  x64: 'x64',
  amd64: 'x64',
  x86_64: 'x64',
};
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.(nano|micro|small|medium|large|metal|\d*xlarge)$/;

/** Graviton families, best price-performance first. */
const EC2_FAMILIES_ARM64 = ['m8g', 'm7g', 'c8g', 'c7g', 'r8g', 'r7g'];
const EC2_FAMILIES_X64 = ['m7i', 'm7a', 'c7i', 'c7a', 'm6i', 'r7i'];
const GB_PER_VCPU: Record<string, number> = { c: 2, m: 4, r: 8 };
const EC2_SIZE_BY_CPU: Record<number, string> = {
  2: 'large',
  4: 'xlarge',
  8: '2xlarge',
  16: '4xlarge',
  32: '8xlarge',
  48: '12xlarge',
  64: '16xlarge',
};

/** MicroVM baseline sizes (GiB memory = 2 x vCPU). */
const MICROVM_CPUS = [1, 2, 4];
/** Fargate: allowed vCPU values and the memory range (GiB) for each. */
const FARGATE_MEMORY: Record<number, [number, number]> = {
  1: [2, 8],
  2: [4, 16],
  4: [8, 30],
  8: [16, 60],
  16: [32, 120],
};
/** Lambda gives about one vCPU per 1,769 MB, up to 6 vCPU at 10,240 MB. */
export const LAMBDA_MB_PER_VCPU = 1769;
export const LAMBDA_MAX_MB = 10240;
export const LAMBDA_MAX_CPU = 6;

export function hasTrigger(labels: string[]): boolean {
  return labels.some((l) => l.toLowerCase() === TRIGGER_LABEL);
}

export function parseLabels(rawLabels: string[], defaults: LabelDefaults): ParseResult {
  const labels = rawLabels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  let compute: Compute | undefined;
  let arch: Arch | undefined;
  let cpu: number | undefined;
  let memoryGb: number | undefined;
  let diskGb: number | undefined;
  let instanceType: string | undefined;
  let spot = false;
  const fail = (error: string): ParseResult => ({ ok: false, error });

  for (const label of labels) {
    if (IGNORED.has(label)) continue;
    const size = /^(\d+)(cpu|gb)$/.exec(label);
    const disk = /^disk-(\d+)gb$/.exec(label);
    if ((COMPUTES as readonly string[]).includes(label)) {
      if (compute && compute !== label) return fail(`two compute types: ${compute} and ${label}`);
      compute = label as Compute;
    } else if (label in ARCH_ALIASES) {
      arch = ARCH_ALIASES[label];
    } else if (size?.[2] === 'cpu') {
      cpu = Number(size[1]);
    } else if (size?.[2] === 'gb') {
      memoryGb = Number(size[1]);
    } else if (disk) {
      diskGb = Number(disk[1]);
    } else if (label === 'spot') {
      spot = true;
    } else if (INSTANCE_TYPE.test(label)) {
      instanceType = label;
    } else {
      return fail(
        `unknown label "${label}". Use a compute type (${COMPUTES.join(', ')}), arm64/x64, ` +
          'a size like 2cpu or 8gb, disk-50gb, spot, or an EC2 instance type like c7g.large',
      );
    }
  }

  if (instanceType) {
    if (compute && compute !== 'ec2')
      return fail(`instance type ${instanceType} needs ec2, not ${compute}`);
    compute = 'ec2';
  }
  compute ??= defaults.compute;
  if (spot && compute !== 'ec2') return fail(`spot is only available on ec2, not ${compute}`);
  if (cpu === 0 || memoryGb === 0 || diskGb === 0) return fail('sizes must be greater than zero');

  switch (compute) {
    case 'microvm': {
      arch ??= 'arm64';
      cpu ??= 1;
      if (!MICROVM_CPUS.includes(cpu)) {
        return fail(
          `microvm sizes are ${MICROVM_CPUS.map((c) => `${c}cpu`).join(', ')} (baseline; bursts to 4x)`,
        );
      }
      if (memoryGb !== undefined && memoryGb !== cpu * 2) {
        return fail(`microvm memory is fixed at 2gb per vCPU (${cpu}cpu = ${cpu * 2}gb)`);
      }
      if (diskGb !== undefined)
        return fail(
          'microvm disk size follows the size: 8 GB up to 1cpu, 16 GB at 2cpu, 32 GB at 4cpu',
        );
      return { ok: true, spec: { compute, arch, cpu, memoryGb: cpu * 2, spot } };
    }
    case 'fargate': {
      arch ??= 'x64';
      cpu ??= 2;
      const range = FARGATE_MEMORY[cpu];
      if (!range)
        return fail(
          `fargate sizes are ${Object.keys(FARGATE_MEMORY)
            .map((c) => `${c}cpu`)
            .join(', ')}`,
        );
      memoryGb ??= range[0];
      if (memoryGb < range[0] || memoryGb > range[1]) {
        return fail(`fargate ${cpu}cpu needs ${range[0]}-${range[1]}gb of memory`);
      }
      if (diskGb !== undefined && (diskGb < 21 || diskGb > 200))
        return fail('fargate disk must be 21-200gb');
      return { ok: true, spec: { compute, arch, cpu, memoryGb, diskGb, spot } };
    }
    case 'lambda': {
      arch ??= 'arm64';
      if (diskGb !== undefined) return fail('lambda disk is fixed (10 GB of /tmp)');
      if (cpu !== undefined && cpu > LAMBDA_MAX_CPU)
        return fail(`lambda allows up to ${LAMBDA_MAX_CPU}cpu`);
      if (memoryGb !== undefined && memoryGb * 1024 > LAMBDA_MAX_MB)
        return fail('lambda allows up to 10gb of memory');
      cpu ??= memoryGb ? Math.max(1, Math.floor((memoryGb * 1024) / LAMBDA_MB_PER_VCPU)) : 1;
      memoryGb ??= Math.min(LAMBDA_MAX_MB, cpu * LAMBDA_MB_PER_VCPU) / 1024;
      return { ok: true, spec: { compute, arch, cpu, memoryGb, spot } };
    }
    case 'ec2': {
      if (diskGb !== undefined && (diskGb < 8 || diskGb > 2000))
        return fail('ec2 disk must be 8-2000gb');
      if (instanceType) {
        const inferred = archOfInstanceType(instanceType);
        if (arch && inferred && arch !== inferred)
          return fail(`${instanceType} is ${inferred}, not ${arch}`);
        return {
          ok: true,
          spec: {
            compute,
            arch: arch ?? inferred ?? 'x64',
            cpu: cpu ?? 0,
            memoryGb: memoryGb ?? 0,
            diskGb,
            instanceTypes: [instanceType],
            spot,
          },
        };
      }
      arch ??= 'x64';
      const vcpus = cpu ?? 2;
      const size = EC2_SIZE_BY_CPU[vcpus];
      if (!size)
        return fail(
          `ec2 sizes are ${Object.keys(EC2_SIZE_BY_CPU)
            .map((c) => `${c}cpu`)
            .join(', ')}, or name an instance type`,
        );
      const families = (arch === 'arm64' ? EC2_FAMILIES_ARM64 : EC2_FAMILIES_X64).filter(
        (f) => memoryGb === undefined || GB_PER_VCPU[f[0]] * vcpus >= memoryGb,
      );
      if (families.length === 0)
        return fail(
          `no ${vcpus}cpu instance type has ${memoryGb}gb; name an instance type instead`,
        );
      const instanceTypes = families.map((f) => `${f}.${size}`);
      const smallest = Math.min(...families.map((f) => GB_PER_VCPU[f[0]] * vcpus));
      return {
        ok: true,
        spec: {
          compute,
          arch,
          cpu: vcpus,
          memoryGb: memoryGb ?? smallest,
          diskGb,
          instanceTypes,
          spot,
        },
      };
    }
  }
}

/** Graviton types have a `g` after the generation number (m7g, c8gd, r7gn); a1 is Graviton 1. */
export function archOfInstanceType(type: string): Arch | undefined {
  const family = type.split('.')[0];
  if (family === 'a1' || /^[a-z]+\d+g[a-z]*$/.test(family)) return 'arm64';
  if (/^[a-z]+\d+[a-z]*$/.test(family)) return 'x64';
  return undefined;
}

/** A short, human-readable description for logs and the CLI. */
export function describeSpec(spec: JobSpec): string {
  const parts: string[] = [spec.compute, spec.arch];
  if (spec.instanceTypes?.length === 1 && spec.cpu === 0) parts.push(spec.instanceTypes[0]);
  else parts.push(`${spec.cpu}cpu`, `${spec.memoryGb}gb`);
  if (spec.diskGb) parts.push(`disk-${spec.diskGb}gb`);
  if (spec.spot) parts.push('spot');
  return parts.join(' ');
}

/**
 * The same job on another compute type, for fallback: the smallest size there with at least
 * the requested vCPUs and memory, keeping the architecture. Undefined when it can't fit.
 */
export function specFor(compute: Compute, from: JobSpec): JobSpec | undefined {
  if (compute === from.compute) return from;
  const want = { cpu: Math.max(from.cpu, 1), mem: Math.max(from.memoryGb, 1) };
  switch (compute) {
    case 'microvm': {
      if (from.arch !== 'arm64') return undefined;
      const cpu = MICROVM_CPUS.find((c) => c >= want.cpu && c * 2 >= want.mem);
      return cpu ? { compute, arch: 'arm64', cpu, memoryGb: cpu * 2, spot: false } : undefined;
    }
    case 'fargate': {
      for (const [c, [min, max]] of Object.entries(FARGATE_MEMORY)) {
        const cpu = Number(c);
        if (cpu >= want.cpu && max >= want.mem) {
          const memoryGb = Math.max(min, Math.ceil(want.mem));
          const diskGb = from.diskGb ? Math.min(200, Math.max(21, from.diskGb)) : undefined;
          return { compute, arch: from.arch, cpu, memoryGb, diskGb, spot: false };
        }
      }
      return undefined;
    }
    case 'lambda': {
      if (want.cpu > LAMBDA_MAX_CPU || want.mem * 1024 > LAMBDA_MAX_MB) return undefined;
      const memoryGb =
        Math.min(LAMBDA_MAX_MB, Math.max(want.cpu * LAMBDA_MB_PER_VCPU, want.mem * 1024)) / 1024;
      return { compute, arch: from.arch, cpu: want.cpu, memoryGb, spot: false };
    }
    case 'ec2': {
      const cpu = Object.keys(EC2_SIZE_BY_CPU)
        .map(Number)
        .find((c) => c >= want.cpu);
      if (!cpu) return undefined;
      const families = (from.arch === 'arm64' ? EC2_FAMILIES_ARM64 : EC2_FAMILIES_X64).filter(
        (f) => GB_PER_VCPU[f[0]] * cpu >= want.mem,
      );
      if (families.length === 0) return undefined;
      const instanceTypes = families.map((f) => `${f}.${EC2_SIZE_BY_CPU[cpu]}`);
      const memoryGb = Math.min(...families.map((f) => GB_PER_VCPU[f[0]] * cpu));
      return {
        compute,
        arch: from.arch,
        cpu,
        memoryGb,
        diskGb: from.diskGb,
        instanceTypes,
        spot: false,
      };
    }
  }
}
