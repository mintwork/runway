// What runway has launched, in one DynamoDB table:
//   pk = "job#<jobId>"   claims a queued job so a redelivered webhook can't launch twice
//   pk = "<runnerName>"  one item per runner: what was launched, for which job, and its state
// Items expire via the `ttl` attribute, so the table never needs cleaning.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Compute } from './labels.js';

export type RunnerState = 'launching' | 'launched' | 'busy' | 'done' | 'failed';

export interface RunnerRecord {
  pk: string;
  compute: Compute;
  resourceId?: string;
  detail?: string;
  owner: string;
  repo: string;
  ownerIsOrg: boolean;
  installationId: number;
  /** The queued job this runner was launched for. GitHub may hand it a different queued job with the same labels. */
  jobId: number;
  runId: number;
  runnerId?: number;
  /** The job the runner actually picked up (from the in_progress webhook). */
  busyJobId?: number;
  state: RunnerState;
  error?: string;
  launchedAt: number;
  ttl: number;
}

export interface Refusal {
  pk: string;
  jobId: number;
  owner: string;
  repo: string;
  labels: string[];
  reason: string;
  at: number;
  ttl: number;
}

const DAY = 24 * 3600;

export class State {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.db = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  /** Atomically claim a job. Returns false when another delivery already claimed it. */
  async claimJob(jobId: number, runnerName: string, now = Date.now()): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `job#${jobId}`, runnerName, ttl: Math.floor(now / 1000) + 2 * DAY },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  /** Remember why a job was refused, so `runway status` can say why it's still waiting. */
  async recordRefusal(refusal: Omit<Refusal, 'pk' | 'ttl'>): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...refusal,
          pk: `refused#${refusal.jobId}`,
          ttl: Math.floor(refusal.at / 1000) + 3 * DAY,
        },
      }),
    );
  }

  async releaseJob(jobId: number): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `job#${jobId}` } }));
  }

  async putRunner(record: RunnerRecord): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: record }));
  }

  async getRunner(runnerName: string): Promise<RunnerRecord | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { pk: runnerName } }),
    );
    return res.Item as RunnerRecord | undefined;
  }

  async update(runnerName: string, fields: Partial<Omit<RunnerRecord, 'pk'>>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: runnerName },
        UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
        ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }

  /** Every runner that hasn't finished. The table is small (one item per recent job), so a scan is fine. */
  async activeRunners(): Promise<RunnerRecord[]> {
    const out: RunnerRecord[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: 'begins_with(pk, :p) AND #s IN (:a, :b, :c)',
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: {
            ':p': 'runway-',
            ':a': 'launching',
            ':b': 'launched',
            ':c': 'busy',
          },
          ExclusiveStartKey,
        }),
      );
      out.push(...((page.Items ?? []) as RunnerRecord[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
}

export function ttlFromNow(seconds: number, now = Date.now()): number {
  return Math.floor(now / 1000) + seconds;
}
