import type { Compute, JobSpec } from '../core/labels.js';

export interface LaunchRequest {
  /** Unique runner name (runway-xxxxxxxx); also used as the idempotency token. */
  runnerName: string;
  /** GitHub's encoded just-in-time runner config: single-use, valid for one job. */
  jitConfig: string;
  spec: JobSpec;
  /** Hard cap on how long the machine may live. */
  maxSeconds: number;
}

export interface Launched {
  /** Provider-specific id: MicroVM id, EC2 instance id, ECS task ARN, Lambda request id. */
  resourceId: string;
  /** What actually launched, e.g. the instance type or "spot". */
  detail?: string;
}

export interface ManagedResource {
  resourceId: string;
  startedAt: number;
}

export interface Provider {
  readonly compute: Compute;
  launch(req: LaunchRequest): Promise<Launched>;
  /** Stop billing for the resource. Must be idempotent: terminating twice is fine. */
  terminate(resourceId: string): Promise<void>;
  /** Everything this stack is running on this provider, for the orphan sweep. */
  listManaged(): Promise<ManagedResource[]>;
}

/**
 * No capacity, quota exhausted, or the compute type isn't set up: the worker tries the
 * next compute type in the fallback chain instead of retrying the same one.
 */
export class CapacityError extends Error {
  constructor(
    readonly compute: Compute,
    message: string,
  ) {
    super(`${compute}: ${message}`);
  }
}

const CAPACITY_CODES = [
  'InsufficientInstanceCapacity',
  'InsufficientCapacity',
  'InsufficientCapacityException',
  'SpotMaxPriceTooLow',
  'MaxSpotInstanceCountExceeded',
  'InstanceLimitExceeded',
  'VcpuLimitExceeded',
  'Unsupported',
  'ServiceQuotaExceededException',
  'LimitExceededException',
  'ResourceLimitExceeded',
  'CapacityUnavailable',
];

/** True for AWS errors that mean "not here, not now", as opposed to bugs or throttling. */
export function isCapacityError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  const msg = (e as { message?: string })?.message ?? '';
  return (
    CAPACITY_CODES.includes(name) ||
    /insufficient capacity|capacity is unavailable|quota|limit exceeded|not supported/i.test(msg)
  );
}
