import { describe, expect, it } from 'vitest';
import {
  archOfInstanceType,
  describeSpec,
  hasTrigger,
  parseLabels,
  specFor,
} from '../src/core/labels.js';

const defaults = { compute: 'microvm' as const };
const parse = (...labels: string[]) => parseLabels(['runway', ...labels], defaults);
const spec = (...labels: string[]) => {
  const r = parse(...labels);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
};
const error = (...labels: string[]) => {
  const r = parse(...labels);
  if (r.ok) throw new Error(`expected an error for ${labels.join(',')}`);
  return r.error;
};

describe('hasTrigger', () => {
  it('needs the runway label, in any case', () => {
    expect(hasTrigger(['self-hosted', 'Runway'])).toBe(true);
    expect(hasTrigger(['ubuntu-latest'])).toBe(false);
  });
});

describe('parseLabels: defaults', () => {
  it('uses the stack default compute with its default size', () => {
    expect(spec()).toEqual({ compute: 'microvm', arch: 'arm64', cpu: 1, memoryGb: 2, spot: false });
  });

  it('ignores self-hosted and linux', () => {
    expect(parseLabels(['self-hosted', 'linux', 'runway', 'fargate'], defaults).ok).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(spec('EC2', 'ARM64', '4CPU')).toMatchObject({ compute: 'ec2', arch: 'arm64', cpu: 4 });
  });
});

describe('parseLabels: microvm', () => {
  it('maps cpu to the 2 GB per vCPU baseline', () => {
    expect(spec('microvm', '4cpu')).toMatchObject({ cpu: 4, memoryGb: 8, arch: 'arm64' });
  });

  it('rejects sizes and memory that MicroVMs do not offer', () => {
    expect(error('microvm', '3cpu')).toContain('1cpu, 2cpu, 4cpu');
    expect(error('microvm', '2cpu', '16gb')).toContain('2cpu = 4gb');
    expect(error('microvm', 'disk-50gb')).toContain('disk size follows the size');
  });
});

describe('parseLabels: fargate', () => {
  it('defaults to x64, 2 vCPU and the minimum memory', () => {
    expect(spec('fargate')).toEqual({
      compute: 'fargate',
      arch: 'x64',
      cpu: 2,
      memoryGb: 4,
      spot: false,
    });
  });

  it('accepts memory and disk inside the Fargate ranges', () => {
    expect(spec('fargate', '4cpu', '16gb', 'disk-100gb')).toMatchObject({
      cpu: 4,
      memoryGb: 16,
      diskGb: 100,
    });
  });

  it('rejects combinations Fargate cannot run', () => {
    expect(error('fargate', '3cpu')).toContain('fargate sizes are');
    expect(error('fargate', '1cpu', '16gb')).toBe('fargate 1cpu needs 2-8gb of memory');
    expect(error('fargate', 'disk-10gb')).toBe('fargate disk must be 21-200gb');
  });
});

describe('parseLabels: lambda', () => {
  it('gives one vCPU per 1,769 MB', () => {
    expect(spec('lambda')).toMatchObject({ cpu: 1, arch: 'arm64' });
    expect(spec('lambda').memoryGb * 1024).toBe(1769);
    expect(spec('lambda', '2cpu').memoryGb * 1024).toBe(3538);
  });

  it('derives vCPUs from memory and caps at 10 GB', () => {
    expect(spec('lambda', '8gb')).toMatchObject({ cpu: 4, memoryGb: 8 });
    expect(spec('lambda', '6cpu').memoryGb * 1024).toBe(10240);
    expect(error('lambda', '7cpu')).toBe('lambda allows up to 6cpu');
    expect(error('lambda', '12gb')).toBe('lambda allows up to 10gb of memory');
    expect(error('lambda', 'disk-20gb')).toContain('fixed');
  });
});

describe('parseLabels: ec2', () => {
  it('picks instance families for the size, best first', () => {
    expect(spec('ec2', 'arm64', '4cpu').instanceTypes).toEqual([
      'm8g.xlarge',
      'm7g.xlarge',
      'c8g.xlarge',
      'c7g.xlarge',
      'r8g.xlarge',
      'r7g.xlarge',
    ]);
    expect(spec('ec2').instanceTypes?.[0]).toBe('m7i.large');
  });

  it('drops families that cannot fit the requested memory', () => {
    const s = spec('ec2', 'x64', '2cpu', '16gb');
    expect(s.instanceTypes).toEqual(['r7i.large']);
    expect(s.memoryGb).toBe(16);
    expect(error('ec2', '2cpu', '64gb')).toContain('name an instance type instead');
  });

  it('treats an instance type as ec2 and infers its architecture', () => {
    expect(spec('c7g.2xlarge', 'disk-100gb')).toMatchObject({
      compute: 'ec2',
      arch: 'arm64',
      instanceTypes: ['c7g.2xlarge'],
      diskGb: 100,
    });
    expect(spec('g5.xlarge').arch).toBe('x64');
    expect(error('c7g.large', 'x64')).toBe('c7g.large is arm64, not x64');
    expect(error('fargate', 'c7g.large')).toBe('instance type c7g.large needs ec2, not fargate');
  });

  it('allows spot only on ec2', () => {
    expect(spec('ec2', 'spot').spot).toBe(true);
    expect(error('lambda', 'spot')).toBe('spot is only available on ec2, not lambda');
  });
});

describe('parseLabels: mistakes fail loudly', () => {
  it('rejects unknown labels, naming them', () => {
    expect(error('4cpus')).toContain('unknown label "4cpus"');
  });

  it('rejects two compute types and zero sizes', () => {
    expect(error('ec2', 'lambda')).toBe('two compute types: ec2 and lambda');
    expect(error('0cpu')).toBe('sizes must be greater than zero');
  });
});

describe('archOfInstanceType', () => {
  it('recognizes Graviton families', () => {
    expect(archOfInstanceType('m7gd.large')).toBe('arm64');
    expect(archOfInstanceType('a1.large')).toBe('arm64');
    expect(archOfInstanceType('m7i-flex.large')).toBe(undefined);
    expect(archOfInstanceType('c6in.large')).toBe('x64');
  });
});

describe('describeSpec', () => {
  it('summarizes the spec', () => {
    expect(describeSpec(spec('ec2', 'spot', 'arm64', '4cpu', 'disk-50gb'))).toBe(
      'ec2 arm64 4cpu 8gb disk-50gb spot',
    );
    expect(describeSpec(spec('c7g.large'))).toBe('ec2 arm64 c7g.large');
  });
});

describe('specFor (fallback sizing)', () => {
  it('rounds a 1 vCPU MicroVM up to the smallest EC2 size', () => {
    const s = specFor('ec2', spec('microvm'));
    expect(s).toMatchObject({ compute: 'ec2', arch: 'arm64', cpu: 2, memoryGb: 4, spot: false });
    expect(s?.instanceTypes?.[0]).toBe('m8g.large');
  });

  it('keeps memory and disk when moving to Fargate', () => {
    expect(specFor('fargate', spec('ec2', 'x64', '4cpu', '16gb', 'disk-100gb'))).toEqual({
      compute: 'fargate',
      arch: 'x64',
      cpu: 4,
      memoryGb: 16,
      diskGb: 100,
      spot: false,
    });
  });

  it('refuses targets that cannot fit the job', () => {
    expect(specFor('lambda', spec('ec2', '8cpu'))).toBeUndefined();
    expect(specFor('microvm', spec('ec2', 'arm64', '8cpu'))).toBeUndefined();
  });

  it('keeps the architecture when falling back to a MicroVM', () => {
    expect(specFor('microvm', spec('fargate', 'x64'))).toMatchObject({
      compute: 'microvm',
      arch: 'x64',
      cpu: 2,
      memoryGb: 4,
    });
  });

  it('returns the same spec for the same compute', () => {
    const s = spec('fargate');
    expect(specFor('fargate', s)).toBe(s);
  });
});
