import { Command } from 'commander';
import type { WebhookEndpoint, WebhookEventType, WebhookStatus } from '@genfire/sdk';
import { createClient } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, green, printResult, printTable, yellow } from '../output.js';

const VALID_EVENTS = new Set<WebhookEventType>([
  'run.completed',
  'run.failed',
  'batch.completed',
  'batch.failed'
]);

function parseEvents(value: string | undefined): WebhookEventType[] | undefined {
  if (!value) return undefined;
  const events = value.split(',').map((e) => e.trim()).filter(Boolean);
  for (const event of events) {
    if (!VALID_EVENTS.has(event as WebhookEventType)) {
      throw new CliError(
        `Invalid event "${event}". Valid events: ${[...VALID_EVENTS].join(', ')}`,
        'invalid_event'
      );
    }
  }
  return events as WebhookEventType[];
}

function statusColor(status: string): string {
  return status === 'active' ? green(status) : yellow(status);
}

function printEndpoint(endpoint: WebhookEndpoint, secret?: string): void {
  process.stdout.write(`${bold(endpoint.url)}\n`);
  process.stdout.write(`${dim('ID:')}       ${endpoint.id}\n`);
  process.stdout.write(`${dim('Status:')}   ${statusColor(endpoint.status)}\n`);
  process.stdout.write(`${dim('Events:')}   ${endpoint.events.join(', ') || dim('(none)')}\n`);
  if (endpoint.description) {
    process.stdout.write(`${dim('Note:')}     ${endpoint.description}\n`);
  }
  if (secret) {
    process.stdout.write(`${dim('Secret:')}   ${cyan(secret)}\n`);
    process.stdout.write(`${yellow('Save this signing secret now — it is only returned once.')}\n`);
  } else {
    process.stdout.write(`${dim('Secret:')}   ${endpoint.signing_secret_preview} ${dim('(preview)')}\n`);
  }
  if (endpoint.last_delivery_at) {
    process.stdout.write(`${dim('Last hit:')} ${endpoint.last_delivery_at}\n`);
  }
}

export function registerWebhooksCommand(program: Command): void {
  const webhooks = program
    .command('webhooks')
    .description('Manage webhook endpoints that receive run and batch events');

  webhooks
    .command('list')
    .description('List your webhook endpoints')
    .action(async () => {
      const client = await createClient();
      const response = await client.listWebhooks();
      printResult(response, () => {
        printTable(
          response.data.map((e) => ({
            id: e.id,
            url: e.url,
            status: e.status,
            events: e.events.join(','),
            last_delivery: e.last_delivery_at || '—'
          })),
          ['id', 'url', 'status', 'events', 'last_delivery']
        );
      });
    });

  webhooks
    .command('create <url>')
    .description('Register an endpoint. Returns the signing secret once — save it.')
    .option('-e, --events <list>', `Comma-separated events (default: all). Valid: ${[...VALID_EVENTS].join(', ')}`)
    .option('-d, --description <text>', 'What this endpoint is for')
    .action(async (url: string, opts: { events?: string; description?: string }) => {
      const client = await createClient();
      const endpoint = await client.createWebhook({
        url,
        events: parseEvents(opts.events),
        description: opts.description
      });
      printResult(endpoint, () => {
        process.stdout.write(`${green('✓')} Webhook created\n`);
        printEndpoint(endpoint, endpoint.signing_secret);
      });
    });

  webhooks
    .command('update <endpointId>')
    .description('Change an endpoint URL, events, description, or status')
    .option('-u, --url <url>', 'New delivery URL')
    .option('-e, --events <list>', 'Replace the subscribed events (comma-separated)')
    .option('-d, --description <text>', 'New description')
    .option('--clear-description', 'Remove the description')
    .option('--status <status>', 'active | disabled')
    .action(async (endpointId: string, opts: {
      url?: string; events?: string; description?: string; clearDescription?: boolean; status?: string;
    }) => {
      if (opts.status && opts.status !== 'active' && opts.status !== 'disabled') {
        throw new CliError(`Invalid --status: ${opts.status}. Use active or disabled.`, 'invalid_status');
      }
      if (opts.description && opts.clearDescription) {
        throw new CliError('Use either --description or --clear-description, not both.', 'conflicting_description');
      }
      const hasChange = opts.url || opts.events || opts.description || opts.clearDescription || opts.status;
      if (!hasChange) {
        throw new CliError('Nothing to update. Pass --url, --events, --description, or --status.', 'no_changes');
      }
      const client = await createClient();
      const endpoint = await client.updateWebhook(endpointId, {
        url: opts.url,
        events: parseEvents(opts.events),
        description: opts.clearDescription ? null : opts.description,
        status: opts.status as WebhookStatus | undefined
      });
      printResult(endpoint, () => {
        process.stdout.write(`${green('✓')} Webhook updated\n`);
        printEndpoint(endpoint);
      });
    });

  webhooks
    .command('delete <endpointId>')
    .description('Remove an endpoint permanently')
    .action(async (endpointId: string) => {
      const client = await createClient();
      await client.deleteWebhook(endpointId);
      printResult({ id: endpointId, deleted: true }, () => {
        process.stdout.write(`${green('✓')} Deleted webhook ${endpointId}\n`);
      });
    });

  webhooks
    .command('deliveries')
    .description('Inspect recent delivery attempts')
    .option('-e, --endpoint <endpointId>', 'Only deliveries for this endpoint')
    .option('-n, --limit <count>', 'Maximum deliveries to return')
    .action(async (opts: { endpoint?: string; limit?: string }) => {
      const limit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new CliError(`Invalid --limit: ${opts.limit}`, 'invalid_limit');
      }
      const client = await createClient();
      const response = await client.listWebhookDeliveries({ endpointId: opts.endpoint, limit });
      printResult(response, () => {
        printTable(
          response.data.map((d) => ({
            id: d.id,
            event: d.event_type,
            status: d.status,
            attempts: `${d.attempt_count}/${d.max_attempts}`,
            response: d.response_status ?? '—',
            created: d.created_at
          })),
          ['id', 'event', 'status', 'attempts', 'response', 'created']
        );
      });
    });

  webhooks
    .command('replay <deliveryId>')
    .description('Re-send a delivery that failed')
    .action(async (deliveryId: string) => {
      const client = await createClient();
      const delivery = await client.replayWebhookDelivery(deliveryId);
      printResult(delivery, () => {
        process.stdout.write(`${green('✓')} Replayed delivery ${delivery.id}\n`);
        process.stdout.write(`${dim('Status:')}   ${delivery.status}\n`);
        process.stdout.write(`${dim('Attempts:')} ${delivery.attempt_count}/${delivery.max_attempts}\n`);
        if (delivery.response_status !== null) {
          process.stdout.write(`${dim('Response:')} ${delivery.response_status}\n`);
        }
        if (delivery.last_error) {
          process.stdout.write(`${yellow('Error:')}    ${delivery.last_error}\n`);
        }
      });
    });
}
