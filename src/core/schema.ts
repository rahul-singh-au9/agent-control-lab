import { z } from 'zod';

export const MAX_TRACE_BYTES = 64 * 1024;
export const MAX_EVENTS = 200;
export const SUPPORTED_TOOL = 'publish_artifact' as const;

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Use a simple, nonempty identifier.');
const shortText = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, 'Must not be blank.');
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => !/\.\d{4,}/.test(value),
    'Use at most three fractional second digits (millisecond precision).',
  );
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest (64 hexadecimal characters).');
const source = z.enum(['authority', 'resource', 'agent', 'tool']);
const common = {
  id: identifier,
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp,
};
const binding = {
  actor: identifier,
  session: identifier,
  resource: identifier,
  destination: shortText,
  version: identifier,
  digest,
};

const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...common,
    type: z.literal('grant'),
    source: z.literal('authority'),
    grantId: identifier,
    ...binding,
    expiresAt: timestamp,
    maxUses: z.number().int().min(1).max(1000),
  }),
  z.strictObject({
    ...common,
    type: z.literal('revoke'),
    source: z.literal('authority'),
    grantId: identifier,
  }),
  z.strictObject({
    ...common,
    type: z.literal('state'),
    source: z.literal('resource'),
    resource: identifier,
    version: identifier,
    digest,
  }),
  z.strictObject({
    ...common,
    type: z.literal('proposal'),
    source: z.literal('agent'),
    actionId: identifier,
    grantId: identifier,
    tool: shortText,
    ...binding,
  }),
  z.strictObject({
    ...common,
    type: z.literal('dispatch'),
    source: z.literal('tool'),
    actionId: identifier,
  }),
  z.strictObject({
    ...common,
    type: z.literal('result'),
    source: z.literal('tool'),
    actionId: identifier,
    outcome: z.enum(['succeeded', 'failed']),
  }),
  z.strictObject({ ...common, type: z.literal('context'), source, content: z.string().max(8000) }),
]);

const referenceLabelSchema = z.strictObject({
  actionId: identifier,
  expected: z.enum(['permitted', 'forbidden', 'unknown']),
  ruleId: identifier,
  evidenceEventIds: z.array(identifier).min(1).max(MAX_EVENTS),
});

const traceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  title: z
    .string()
    .min(1)
    .max(160)
    .refine((value) => value.trim().length > 0, 'Must not be blank.'),
  origin: z.enum(['fixture', 'captured']),
  coverage: z.strictObject({
    authorization: z.enum(['complete', 'partial']),
    resourceState: z.enum(['complete', 'partial']),
  }),
  events: z.array(eventSchema).min(1).max(MAX_EVENTS),
  labels: z.array(referenceLabelSchema).max(MAX_EVENTS).optional(),
});

export type Trace = z.infer<typeof traceSchema>;
export type TraceEvent = z.infer<typeof eventSchema>;
export type ReferenceLabel = z.infer<typeof referenceLabelSchema>;
export type GrantEvent = Extract<TraceEvent, { type: 'grant' }>;
export type ProposalEvent = Extract<TraceEvent, { type: 'proposal' }>;
export type StateEvent = Extract<TraceEvent, { type: 'state' }>;

function checkSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_TRACE_BYTES) {
    throw new Error('Trace exceeds the 64 KiB limit. Import a smaller, redacted trace.');
  }
}

function checkCollectionBounds(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const trace = input as Record<string, unknown>;
  const check = (value: unknown, path: string) => {
    if (Array.isArray(value) && value.length > MAX_EVENTS) {
      throw new Error(`${path}: Use at most ${MAX_EVENTS} items.`);
    }
  };

  // Reject oversized collections before schema validation allocates errors for every item.
  check(trace.events, 'events');
  check(trace.labels, 'labels');
  if (!Array.isArray(trace.labels)) return;
  const labels: unknown[] = trace.labels;
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    if (!label || typeof label !== 'object' || Array.isArray(label)) continue;
    check((label as Record<string, unknown>).evidenceEventIds, `labels.${index}.evidenceEventIds`);
  }
}

function validateTimeline(trace: Trace): void {
  const ids = new Set<string>();
  const grants = new Map<string, GrantEvent>();
  const revoked = new Set<string>();
  const proposals = new Map<string, ProposalEvent>();
  const dispatched = new Set<string>();
  const completed = new Set<string>();
  const versions = new Map<string, Map<string, string>>();
  let lastSeq = 0;
  let lastTime = -Infinity;

  for (const event of trace.events) {
    if (ids.has(event.id)) throw new Error(`Duplicate event ID: ${event.id}.`);
    if (event.seq <= lastSeq)
      throw new Error(`Event ${event.id}: sequence numbers must strictly increase.`);
    const time = Date.parse(event.timestamp);
    if (time < lastTime) throw new Error(`Event ${event.id}: timestamps must not move backwards.`);
    ids.add(event.id);
    lastSeq = event.seq;
    lastTime = time;

    if (event.type === 'grant') {
      if (grants.has(event.grantId)) throw new Error(`Duplicate grant ID: ${event.grantId}.`);
      if (Date.parse(event.expiresAt) <= time)
        throw new Error(`Grant ${event.grantId}: expiration must follow the grant time.`);
      grants.set(event.grantId, event);
    } else if (event.type === 'revoke') {
      if (!grants.has(event.grantId))
        throw new Error(`Event ${event.id}: cannot revoke an unknown or future grant.`);
      if (revoked.has(event.grantId))
        throw new Error(`Grant ${event.grantId} was already revoked.`);
      revoked.add(event.grantId);
    } else if (event.type === 'state') {
      const resourceVersions = versions.get(event.resource) ?? new Map<string, string>();
      const previousDigest = resourceVersions.get(event.version);
      if (previousDigest && previousDigest !== event.digest) {
        throw new Error(
          `Resource ${event.resource}: the same version cannot have different digests.`,
        );
      }
      resourceVersions.set(event.version, event.digest);
      versions.set(event.resource, resourceVersions);
    } else if (event.type === 'proposal') {
      if (proposals.has(event.actionId)) throw new Error(`Duplicate action ID: ${event.actionId}.`);
      proposals.set(event.actionId, event);
    } else if (event.type === 'dispatch') {
      if (!proposals.has(event.actionId))
        throw new Error(`Event ${event.id}: dispatch requires an earlier proposal.`);
      if (dispatched.has(event.actionId))
        throw new Error(
          `Action ${event.actionId} was already dispatched. Retries need a new action ID.`,
        );
      dispatched.add(event.actionId);
    } else if (event.type === 'result') {
      if (!dispatched.has(event.actionId))
        throw new Error(`Event ${event.id}: result requires an earlier dispatch.`);
      if (completed.has(event.actionId))
        throw new Error(`Action ${event.actionId} already has a result.`);
      completed.add(event.actionId);
    }
  }

  if (proposals.size === 0) throw new Error('Trace must contain at least one proposed action.');
  const labelledActions = new Set<string>();
  for (const label of trace.labels ?? []) {
    if (!proposals.has(label.actionId))
      throw new Error(`Label references unknown action: ${label.actionId}.`);
    if (labelledActions.has(label.actionId))
      throw new Error(`Duplicate label for action: ${label.actionId}.`);
    labelledActions.add(label.actionId);
    for (const id of label.evidenceEventIds) {
      if (!ids.has(id))
        throw new Error(`Label for ${label.actionId} references unknown evidence: ${id}.`);
    }
  }
}

/** Parses a raw trace. Labels are optional annotations, never policy instructions. */
export function parseTrace(input: unknown): Trace {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error('Trace must be a JSON object without circular values.');
  }
  if (serialized === undefined) throw new Error('Trace must be a JSON object.');
  checkSize(serialized);
  checkCollectionBounds(input);
  const result = traceSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length ? issue.path.join('.') : 'trace';
    throw new Error(`${path}: ${issue.message}`);
  }
  validateTimeline(result.data);
  return result.data;
}

/** The 64 KiB limit applies to the original text, including whitespace. */
export function parseTraceText(text: string): Trace {
  checkSize(text);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON. Import a raw trace JSON file.');
  }
  return parseTrace(input);
}
