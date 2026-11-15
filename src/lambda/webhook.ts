// GitHub webhook receiver (Lambda Function URL). Verifies the signature, keeps only the
// workflow_job events runway cares about, and queues them for the worker. It answers within
// GitHub's 10-second delivery timeout because the slow part (launching) happens in the worker.
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { loadConfig } from '../core/config.js';
import { verifySignature } from '../core/github.js';
import { hasTrigger } from '../core/labels.js';
import { appCredentials, log } from './runtime.js';

const sqs = new SQSClient({});

export type QueueMessage =
  | {
      type: 'queued';
      jobId: number;
      runId: number;
      labels: string[];
      owner: string;
      repo: string;
      ownerIsOrg: boolean;
      private: boolean;
      installationId: number;
    }
  | { type: 'in_progress'; runnerName: string; jobId: number }
  | { type: 'completed'; runnerName: string; jobId: number };

interface WorkflowJobEvent {
  action: string;
  workflow_job: { id: number; run_id: number; labels: string[]; runner_name?: string | null };
  repository: { name: string; private: boolean; owner: { login: string; type: string } };
  installation?: { id: number };
}

/** The queue message for a workflow_job event, or undefined when runway should ignore it. */
export function toMessage(event: WorkflowJobEvent): QueueMessage | undefined {
  const job = event.workflow_job;
  if (event.action === 'queued') {
    if (!hasTrigger(job.labels) || !event.installation) return undefined;
    return {
      type: 'queued',
      jobId: job.id,
      runId: job.run_id,
      labels: job.labels,
      owner: event.repository.owner.login,
      repo: event.repository.name,
      ownerIsOrg: event.repository.owner.type === 'Organization',
      private: event.repository.private,
      installationId: event.installation.id,
    };
  }
  if (
    (event.action === 'in_progress' || event.action === 'completed') &&
    job.runner_name?.startsWith('runway-')
  ) {
    return { type: event.action, runnerName: job.runner_name, jobId: job.id };
  }
  return undefined;
}

const reply = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({ statusCode, body });

/** API Gateway REST (v1) and HTTP/Function URL (v2) events, with header names lowercased. */
export function normalize(event: APIGatewayProxyEvent | APIGatewayProxyEventV2) {
  const method = 'httpMethod' in event ? event.httpMethod : event.requestContext.http.method;
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? '']),
  );
  const raw = event.body ?? '';
  const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  return { method, headers, body };
}

export async function handler(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const { method, headers, body } = normalize(event);
  if (method !== 'POST') return reply(405, 'POST only');
  const config = loadConfig();
  const creds = await appCredentials(config);
  if (!verifySignature(creds.webhookSecret, body, headers['x-hub-signature-256'])) {
    log('rejected webhook with a bad signature', { delivery: headers['x-github-delivery'] });
    return reply(401, 'bad signature');
  }
  const kind = headers['x-github-event'];
  if (kind === 'ping') return reply(200, 'pong');
  if (kind !== 'workflow_job') return reply(202, 'ignored');

  const message = toMessage(JSON.parse(body) as WorkflowJobEvent);
  if (!message) return reply(202, 'ignored');
  await sqs.send(
    new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: JSON.stringify(message) }),
  );
  return reply(202, 'queued');
}
