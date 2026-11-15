import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, resolveSettings } from '../src/cli/deploy.js';

const stackNow = {
  DefaultCompute: 'ec2',
  Fallback: 'ec2:fargate',
  AllowPublicRepos: 'true',
  MaxJobMinutes: '120',
  MicrovmSizes: 'arm64-1cpu,arm64-2cpu',
  RunnerPolicyArns: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
};

describe('resolveSettings', () => {
  it('uses the defaults on a new stack', () => {
    expect(resolveSettings({}, {})).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the stack's current values for options left out, so update never resets them", () => {
    expect(resolveSettings({}, stackNow)).toEqual({
      defaultCompute: 'ec2',
      fallback: 'ec2:fargate',
      allowPublicRepos: true,
      maxJobMinutes: 120,
      microvmSizes: 'arm64-1cpu,arm64-2cpu',
      runnerPolicies: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
    });
  });

  it('lets options that were passed win, including turning things off', () => {
    const s = resolveSettings(
      { allowPublicRepos: false, runnerPolicies: '', maxJobMinutes: 60 },
      stackNow,
    );
    expect(s).toMatchObject({ allowPublicRepos: false, runnerPolicies: '', maxJobMinutes: 60 });
    expect(s.fallback).toBe('ec2:fargate');
  });

  it('refuses a bad time limit', () => {
    expect(() => resolveSettings({ maxJobMinutes: 2 }, {})).toThrow(/5 to 2880/);
    expect(() => resolveSettings({ maxJobMinutes: Number('abc') }, {})).toThrow();
  });
});
