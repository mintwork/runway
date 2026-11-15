// SQS consumer: launches runners for queued jobs and cleans up after finished ones. When no
// compute type has capacity, the message comes back in 30 seconds (up to the queue's
// maxReceiveCount), so jobs wait for capacity instead of failing.
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { handleCompleted, handleInProgress, handleQueued, RetryLater } from '../core/dispatch.js';
import { log, runtimeDeps } from './runtime.js';
import type { QueueMessage } from './webhook.js';

const sqs = new SQSClient({});
export const CAPACITY_RETRY_SECONDS = 30;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const deps = await runtimeDeps();
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as QueueMessage;
    try {
      if (message.type === 'queued') {
        const { type: _, ...job } = message;
        const outcome = await handleQueued(job, deps);
        if (outcome.status !== 'launched')
          log('queued job not launched', { job: job.jobId, ...outcome });
      } else if (message.type === 'in_progress') {
        await handleInProgress(message.runnerName, message.jobId, deps);
      } else {
        await handleCompleted(message.runnerName, deps);
      }
    } catch (e) {
      failures.push({ itemIdentifier: record.messageId });
      if (e instanceof RetryLater) {
        log('not launched yet; retrying in 30 s', {
          attempt: record.attributes.ApproximateReceiveCount,
          error: e.message,
        });
        await sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: deps.config.queueUrl,
              ReceiptHandle: record.receiptHandle,
              VisibilityTimeout: CAPACITY_RETRY_SECONDS,
            }),
          )
          .catch(() => {});
      } else {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'worker failed',
            type: message.type,
            error: (e as Error).stack,
          }),
        );
      }
    }
  }
  return { batchItemFailures: failures };
}
