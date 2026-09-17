import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fixtures } from '../core/fixtures';
import { parseTrace, type Trace } from '../core/schema';
import { evaluateTrace, type Evaluation } from '../core/evaluate';
import * as api from './api';
import { Icon } from './Icon';
import { MAX_BUNDLE_BYTES, decodeImportBytes, parseImport, traceDigest } from './bundle';

type Tab = 'audit' | 'compare' | 'method';
type Metric = { numerator: number; denominator: number; rate: number | null };
type Notice = { kind: 'success' | 'error' | 'info'; text: string };
type Policy = Evaluation['policies'][number];
type Decision = Policy['decisions'][number];

const decisionLabels: Record<string, string> = {
  allow: 'Allow',
  block: 'Block',
  review: 'Review',
  unsupported: 'Unsupported',
};
const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
};
const metricValue = (metric: Metric) =>
  metric.rate === null ? '—' : `${Math.round(metric.rate * 1000) / 10}%`;

function errorMessage(error: unknown): string {
  if (error instanceof api.ApiError) {
    const retry =
      error.status === 429
        ? ` Too many requests.${error.retryAfter ? ` Retry ${/^\d+$/.test(error.retryAfter) ? `after ${error.retryAfter} seconds` : `at ${error.retryAfter}`}.` : ' Wait a moment, then retry.'}`
        : '';
    return `${error.message}${retry}${error.requestId ? ` Request ID: ${error.requestId}.` : ''}`;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

async function exportBundle(trace: Trace, evaluation?: Evaluation) {
  const bundle = {
    format: 'agent-control-lab',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    traceDigest: await traceDigest(trace),
    digestAlgorithm: 'SHA-256',
    trace,
    ...(evaluation ? { evaluatorVersion: evaluation.evaluatorVersion, evaluation } : {}),
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${
    trace.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 65) || 'trace'
  }-audit.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Dialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      window.requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.matches(':disabled'))
          opener.focus({ preventScroll: true });
        else document.getElementById('main-content')?.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function Badge({ decision }: { decision: string }) {
  return (
    <span className={`decision-badge decision-${decision}`}>
      <span className="badge-dot" />
      {decisionLabels[decision] ?? decision}
    </span>
  );
}

function Ratio({ metric, label }: { metric: Metric; label: string }) {
  return (
    <div className="ratio">
      <span>{label}</span>
      <strong>{metricValue(metric)}</strong>
      <small>
        {metric.denominator === 0
          ? 'No eligible labels'
          : `${metric.numerator} / ${metric.denominator} actions`}
      </small>
    </div>
  );
}

function TraceEvents({ trace, ids }: { trace: Trace; ids: string[] }) {
  if (!ids.length)
    return <p className="muted small">No preceding evidence was available for this decision.</p>;
  return (
    <div className="evidence-list">
      {ids.map((id) => {
        const event = trace.events.find((item) => item.id === id);
        return (
          <details key={id} className="event-evidence">
            <summary>
              <span className="mono">{id}</span>
              <span>{event?.type ?? 'Unavailable'}</span>
              <Icon name="chevron" size={14} />
            </summary>
            <pre>
              {event
                ? JSON.stringify(event, null, 2)
                : 'This evidence event is not present in the trace.'}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function DecisionDetail({
  trace,
  decision,
  policyName,
}: {
  trace: Trace;
  decision?: Decision;
  policyName: string;
}) {
  if (!decision)
    return (
      <div className="detail-empty">
        <Icon name="file" size={28} />
        <h3>Select an action</h3>
        <p>Inspect its decision and the evidence available at that moment.</p>
      </div>
    );
  const proposal = trace.events.find((event) => event.id === decision.eventId);
  const record = proposal?.type === 'proposal' ? proposal : undefined;
  const label = trace.labels?.find((item) => item.actionId === decision.actionId);
  return (
    <section className="decision-detail" aria-label="Selected action evidence">
      <div className="detail-topline">
        <span className="eyebrow">Action evidence</span>
        <span className="mono muted">#{decision.seq}</span>
      </div>
      <h3>{typeof record?.tool === 'string' ? record.tool : decision.actionId}</h3>
      <p className="mono action-id">{decision.actionId}</p>
      <div className="decision-callout">
        <div>
          <Badge decision={decision.decision} />
          <span className="small muted">{policyName}</span>
        </div>
        <p>{decision.reason}</p>
        <code>{decision.reasonCode}</code>
      </div>
      <div className="detail-section">
        <h4>Proposed action</h4>
        <dl className="binding-grid">
          {(['actor', 'session', 'resource', 'destination', 'version', 'grantId'] as const).map(
            (key) => (
              <div key={key}>
                <dt>{key === 'grantId' ? 'Grant' : key.charAt(0).toUpperCase() + key.slice(1)}</dt>
                <dd>{record?.[key] ?? 'Not supplied'}</dd>
              </div>
            ),
          )}
        </dl>
      </div>
      <div className="detail-section">
        <div className="section-title-inline">
          <h4>Supporting events</h4>
          <span className="count-pill">{decision.evidenceEventIds.length}</span>
        </div>
        <p className="muted small">
          Evidence includes this proposal and the earlier records available to the policy.
        </p>
        <TraceEvents trace={trace} ids={decision.evidenceEventIds} />
      </div>
      <div className="detail-section">
        <h4>Reference label</h4>
        {label ? (
          <>
            <p className="label-description">
              <span className={`label-marker label-${label.expected}`} />
              Expected: <strong>{label.expected}</strong>
            </p>
            <p className="mono small muted">Rule: {label.ruleId}</p>
            <p className="muted small">
              Labels are used for scoring and never supplied to either monitor.
            </p>
          </>
        ) : (
          <p className="muted small">
            Unlabelled. This action contributes to decision counts, but not to accuracy metrics.
          </p>
        )}
      </div>
      <details className="raw-event">
        <summary>
          View raw proposal <Icon name="chevron" size={14} />
        </summary>
        <pre>{JSON.stringify(proposal, null, 2)}</pre>
      </details>
    </section>
  );
}

function Audit({
  trace,
  evaluation,
  selectedAction,
  setSelectedAction,
}: {
  trace: Trace;
  evaluation: Evaluation;
  selectedAction: string;
  setSelectedAction: (id: string) => void;
}) {
  const [policyId, setPolicyId] = useState('current-state');
  const policy = evaluation.policies.find((item) => item.id === policyId) ?? evaluation.policies[0];
  const selected =
    policy.decisions.find((item) => item.actionId === selectedAction) ?? policy.decisions[0];
  const staticPolicy = evaluation.policies.find((item) => item.id === 'static-scope');
  const currentPolicy = evaluation.policies.find((item) => item.id === 'current-state');
  return (
    <>
      <div className="summary-strip">
        <div>
          <span className="summary-label">Actions evaluated</span>
          <strong>{policy.metrics.totalActions}</strong>
          <small>
            {policy.metrics.supportedActions} supported · {policy.metrics.unsupportedActions}{' '}
            unsupported
          </small>
        </div>
        <div>
          <span className="summary-label">Allowed</span>
          <strong className="text-teal">{policy.metrics.allowCount}</strong>
          <small>Within this policy</small>
        </div>
        <div>
          <span className="summary-label">Blocked</span>
          <strong className="text-rust">{policy.metrics.blockCount}</strong>
          <small>Policy found a conflict</small>
        </div>
        <div>
          <span className="summary-label">Need review</span>
          <strong className="text-amber">{policy.metrics.reviewCount}</strong>
          <small>Evidence is incomplete</small>
        </div>
      </div>
      <div className="audit-panel">
        <section className="timeline-pane" aria-label="Action timeline">
          <div className="pane-heading">
            <div>
              <h3>Action timeline</h3>
              <p>Compare the same recorded proposal.</p>
            </div>
            <span className="count-pill">{policy.decisions.length}</span>
          </div>
          <div className="timeline-column-head">
            <span>Proposed tool action</span>
            <span>Static</span>
            <span>Stateful</span>
          </div>
          <div className="timeline-list">
            {policy.decisions.map((decision, index) => {
              const event = trace.events.find((item) => item.id === decision.eventId) as unknown as
                Record<string, unknown> | undefined;
              const baseline = staticPolicy?.decisions.find(
                (item) => item.actionId === decision.actionId,
              );
              const stateful = currentPolicy?.decisions.find(
                (item) => item.actionId === decision.actionId,
              );
              return (
                <button
                  key={decision.actionId}
                  className={`timeline-action ${selected?.actionId === decision.actionId ? 'is-selected' : ''}`}
                  onClick={() => setSelectedAction(decision.actionId)}
                  aria-pressed={selected?.actionId === decision.actionId}
                >
                  <span className="action-description">
                    <span className="timeline-index">{String(index + 1).padStart(2, '0')}</span>
                    <span>
                      <strong>
                        {typeof event?.tool === 'string' ? event.tool : decision.actionId}
                      </strong>
                      <small>
                        {typeof event?.resource === 'string' ? event.resource : decision.actionId}
                      </small>
                    </span>
                  </span>
                  <span>
                    <Badge decision={baseline?.decision ?? 'unsupported'} />
                  </span>
                  <span>
                    <Badge decision={stateful?.decision ?? 'unsupported'} />
                  </span>
                </button>
              );
            })}
          </div>
          {!policy.decisions.length && (
            <div className="compact-empty">
              <p>No proposed actions in this trace.</p>
              <span className="small muted">
                Import a trace containing proposal events to inspect decisions.
              </span>
            </div>
          )}
          <div className="timeline-legend">
            <Icon name="info" size={15} />
            <p>These are audit decisions. Recorded actions are never executed or changed.</p>
          </div>
          <details className="all-events">
            <summary>
              Full event log <span>{trace.events.length} events</span>
              <Icon name="chevron" size={14} />
            </summary>
            <div>
              {trace.events.map((event) => (
                <details key={event.id}>
                  <summary>
                    <span className="mono">#{event.seq}</span>
                    <strong>{event.type}</strong>
                    <span className="mono">{event.id}</span>
                  </summary>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </details>
              ))}
            </div>
          </details>
        </section>
        <div className="detail-pane">
          <div className="policy-switch" aria-label="Inspect policy">
            {evaluation.policies.map((item) => (
              <button
                key={item.id}
                className={policy.id === item.id ? 'active' : ''}
                onClick={() => setPolicyId(item.id)}
                aria-pressed={policy.id === item.id}
              >
                {item.id === 'current-state' ? 'Stateful policy' : 'Static baseline'}
              </button>
            ))}
          </div>
          <DecisionDetail trace={trace} decision={selected} policyName={policy.name} />
        </div>
      </div>
    </>
  );
}

function Compare({ evaluation }: { evaluation: Evaluation }) {
  return (
    <div className="comparison-view">
      <div className="view-intro">
        <h2>What changes when state matters?</h2>
        <p>
          Both policies evaluate the same factual event prefix. No agent is rerun, and no
          alternative outcome is inferred.
        </p>
      </div>
      <div className="comparison-cards">
        {evaluation.policies.map((policy) => (
          <section
            className={`comparison-card ${policy.id === 'current-state' ? 'highlighted' : ''}`}
            key={policy.id}
          >
            <div className="comparison-card-heading">
              <span className="eyebrow">
                {policy.id === 'current-state' ? 'State-aware monitor' : 'Baseline monitor'}
              </span>
              <Icon name={policy.id === 'current-state' ? 'shield' : 'file'} size={23} />
            </div>
            <h3>{policy.name}</h3>
            <p>
              {policy.id === 'current-state'
                ? 'Checks current authorization and recorded resource state, including changes across the trace.'
                : 'Freezes grants before the first proposal and checks scope. Later grants, revocations, expiry, usage and state changes are ignored.'}
            </p>
            <div className="ratios">
              <Ratio metric={policy.metrics.forbiddenAllowed} label="Forbidden actions allowed" />
              <Ratio metric={policy.metrics.permittedBlocked} label="Permitted actions blocked" />
              <Ratio
                metric={policy.metrics.permittedInterrupted}
                label="Permitted actions interrupted"
              />
              <Ratio metric={policy.metrics.coverage} label="Label coverage" />
            </div>
          </section>
        ))}
      </div>
      <div className="comparison-table-wrap">
        <table className="comparison-table">
          <caption>Decision counts across every proposed action</caption>
          <thead>
            <tr>
              <th scope="col">Decision</th>
              {evaluation.policies.map((policy) => (
                <th scope="col" key={policy.id}>
                  {policy.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['allow', 'block', 'review', 'unsupported'] as const).map((decision) => (
              <tr key={decision}>
                <th scope="row">
                  <Badge decision={decision} />
                </th>
                {evaluation.policies.map((policy) => (
                  <td key={policy.id}>
                    {decision === 'allow'
                      ? policy.metrics.allowCount
                      : decision === 'block'
                        ? policy.metrics.blockCount
                        : decision === 'review'
                          ? policy.metrics.reviewCount
                          : policy.metrics.unsupportedActions}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="explanation-note">
        <Icon name="info" />
        <div>
          <strong>Read the denominators.</strong>
          <p>
            Unlabelled and unknown-label actions are excluded from accuracy metrics. “Interrupted”
            includes blocked or review decisions on permitted actions. An empty denominator is shown
            as —, never as 0%.
          </p>
        </div>
      </div>
    </div>
  );
}

function Method({ evaluation }: { evaluation: Evaluation | null }) {
  return (
    <div className="method-view">
      <div className="view-intro">
        <span className="eyebrow">Method & boundaries</span>
        <h2>A small, inspectable control experiment.</h2>
        <p>
          The lab asks whether recorded tool actions are consistent with declared authorization and
          state. Its conclusions are limited to the evidence you supply.
        </p>
      </div>
      <div className="method-grid">
        <section>
          <span className="method-number">01</span>
          <h3>Observe a factual prefix</h3>
          <p>
            Events are replayed in sequence. A decision can only use information recorded before the
            proposed action. Later approvals cannot authorize earlier actions.
          </p>
        </section>
        <section>
          <span className="method-number">02</span>
          <h3>Check explicit policy</h3>
          <p>
            The static baseline freezes grants before the first proposal and checks scope bindings.
            The stateful policy additionally checks expiry, revocation, grant use, and version or
            digest changes.
          </p>
        </section>
        <section>
          <span className="method-number">03</span>
          <h3>Keep labels separate</h3>
          <p>
            Optional permitted, forbidden and unknown labels are used only after decisions, for
            scoring. A monitor never receives the expected answer.
          </p>
        </section>
        <section>
          <span className="method-number">04</span>
          <h3>Expose missing evidence</h3>
          <p>
            Incomplete history can require review. Unsupported tools are identified separately; an
            unfamiliar action is never silently counted as a successful check.
          </p>
        </section>
      </div>
      <div className="method-boundaries">
        <h3>What this report does—and cannot establish</h3>
        <ul>
          <li>
            <strong>Offline audit, not intervention.</strong> No imported action is executed. A
            blocked decision does not establish that an attack would have been prevented.
          </li>
          <li>
            <strong>Declared provenance.</strong> Event sources are asserted by the uploader.
            Imported logs do not prove the identity or authenticity of their sources.
          </li>
          <li>
            <strong>Recorded reality.</strong> Each policy sees the original subsequent events, even
            after it would have blocked an action. This is not a counterfactual agent rollout.
          </li>
          <li>
            <strong>Bounded conclusions.</strong> Results describe these traces and these policies.
            They provide no guarantee of general agent or AGI safety.
          </li>
          <li>
            <strong>Educational examples.</strong> The bundled cases are synthetic fixtures with
            paired benign controls, not real incident reports or a representative benchmark.
          </li>
        </ul>
      </div>
      <div className="method-footer">
        <span className="mono">Evaluator {evaluation?.evaluatorVersion ?? '1.0.0'}</span>
        <span>Deterministic policies</span>
        <span>No model calls</span>
      </div>
    </div>
  );
}

export default function App() {
  const [trace, setTrace] = useState<Trace>(fixtures[0].trace);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [tab, setTab] = useState<Tab>('audit');
  const [view, setView] = useState<'workbench' | 'saved'>('workbench');
  const [selectedAction, setSelectedAction] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<api.SavedReportSummary | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [savedReports, setSavedReports] = useState<api.SavedReportSummary[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [session, setSession] = useState<api.SessionInfo | null>(null);
  const [storageError, setStorageError] = useState('');
  const [storageBusy, setStorageBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyReport, setBusyReport] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const importGeneration = useRef(0);
  const libraryGeneration = useRef(0);
  const connectionGeneration = useRef(0);
  const fixture = fixtures.find(
    (item) =>
      item.trace === trace ||
      (item.trace.id === trace.id && JSON.stringify(item.trace) === JSON.stringify(trace)),
  );

  async function connectStorage() {
    const connection = ++connectionGeneration.current;
    const library = libraryGeneration.current;
    setStorageBusy(true);
    setStorageError('');
    try {
      const info = await api.ensureSession();
      const reports = await api.listReports();
      if (connection !== connectionGeneration.current) return;
      setSession(info);
      if (library === libraryGeneration.current) {
        setSavedReports(reports);
        setSavedId((id) => (id && reports.some((report) => report.id === id) ? id : null));
      }
    } catch (error) {
      if (connection === connectionGeneration.current) setStorageError(errorMessage(error));
    } finally {
      if (connection === connectionGeneration.current) setStorageBusy(false);
    }
  }
  useEffect(() => {
    void connectStorage();
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    navigationRef.current?.querySelector<HTMLElement>('a,button')?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeNavigation();
      } else if (event.key === 'Tab') {
        const focusable = Array.from(
          navigationRef.current?.querySelectorAll<HTMLElement>('a,button:not(:disabled)') ?? [],
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const desktop = window.matchMedia('(min-width: 761px)');
    const resized = () => {
      if (desktop.matches) setSidebarOpen(false);
    };
    desktop.addEventListener('change', resized);
    window.addEventListener('keydown', keyboard);
    return () => {
      desktop.removeEventListener('change', resized);
      window.removeEventListener('keydown', keyboard);
      document.body.style.overflow = previousOverflow;
    };
  }, [sidebarOpen]);

  function closeNavigation() {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => navigationToggle.current?.focus());
  }

  function focusWorkspace() {
    if (sidebarOpen)
      window.requestAnimationFrame(() =>
        document.getElementById('main-content')?.focus({ preventScroll: true }),
      );
  }

  function chooseTrace(next: Trace, reportId: string | null = null) {
    generation.current += 1;
    setTrace(next);
    setEvaluation(null);
    setSelectedAction('');
    setSavedId(reportId);
    setView('workbench');
    setTab('audit');
    focusWorkspace();
    setSidebarOpen(false);
    setNotice(null);
  }

  function evaluate() {
    setEvaluating(true);
    setNotice(null);
    const currentGeneration = generation.current;
    window.setTimeout(() => {
      try {
        if (generation.current !== currentGeneration) return;
        const result = evaluateTrace(trace);
        setEvaluation(result);
        setSelectedAction(result.policies[0]?.decisions[0]?.actionId ?? '');
        setTab('audit');
      } catch (error) {
        setNotice({ kind: 'error', text: errorMessage(error) });
      } finally {
        setEvaluating(false);
      }
    }, 0);
  }

  async function importTrace() {
    const currentImport = ++importGeneration.current;
    setImportError('');
    setImporting(true);
    try {
      const next = await parseImport(importText);
      if (currentImport !== importGeneration.current) return;
      chooseTrace(next);
      setImportOpen(false);
      setImportText('');
      setNotice({
        kind: 'success',
        text: 'Trace imported locally. Select Evaluate trace to run the policies. Nothing has been uploaded.',
      });
    } catch (error) {
      if (currentImport === importGeneration.current) setImportError(errorMessage(error));
    } finally {
      if (currentImport === importGeneration.current) setImporting(false);
    }
  }

  function closeImport() {
    importGeneration.current += 1;
    setImporting(false);
    setImportOpen(false);
  }

  async function readFile(file?: File) {
    if (!file) return;
    const currentImport = ++importGeneration.current;
    setImportError('');
    setImportText('');
    if (file.size > MAX_BUNDLE_BYTES) {
      setImportError('File exceeds 1 MiB. Raw traces must be within 64 KiB and 200 events.');
      return;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      if (currentImport === importGeneration.current)
        setImportError('This file could not be read. Try selecting it again or paste its JSON.');
      return;
    }
    if (currentImport !== importGeneration.current) return;
    try {
      setImportText(decodeImportBytes(bytes));
    } catch (error) {
      setImportError(errorMessage(error));
    }
  }

  async function saveCurrent() {
    setSaving(true);
    const currentGeneration = generation.current;
    try {
      if (!session) setSession(await api.ensureSession());
      const report = await api.saveReport(trace);
      libraryGeneration.current += 1;
      setSavedReports((items) => [report, ...items.filter((item) => item.id !== report.id)]);
      if (generation.current === currentGeneration) setSavedId(report.id);
      setSaveOpen(false);
      setStorageError('');
      setNotice({
        kind: 'success',
        text: 'Trace saved to your private browser session. Its audit will be recomputed when opened.',
      });
    } catch (error) {
      if (error instanceof api.ApiError && error.status === 401) {
        setSession(null);
        setStorageError(
          'The browser workspace credential is missing or expired. Retry storage to start a new workspace. Your current trace is still available locally.',
        );
      }
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  async function openSaved(id: string) {
    const currentGeneration = ++generation.current;
    setBusyReport(id);
    try {
      const report = await api.loadReport(id);
      if (currentGeneration !== generation.current) return;
      chooseTrace(parseTrace(report.trace), report.id);
      setNotice({
        kind: 'info',
        text: 'Saved trace loaded. Evaluate it to recompute a report with the current evaluator.',
      });
    } catch (error) {
      if (currentGeneration === generation.current)
        setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusyReport('');
    }
  }

  async function exportSaved(id: string) {
    setBusyReport(id);
    try {
      const report = await api.loadReport(id);
      const imported = parseTrace(report.trace);
      await exportBundle(imported, evaluateTrace(imported));
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusyReport('');
    }
  }

  async function downloadTrace(next: Trace, result?: Evaluation) {
    try {
      await exportBundle(next, result);
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    }
  }

  async function removeSaved() {
    if (!deleteTarget) return;
    setBusyReport(deleteTarget.id);
    try {
      await api.deleteReport(deleteTarget.id);
      libraryGeneration.current += 1;
      setSavedReports((items) => items.filter((item) => item.id !== deleteTarget.id));
      if (savedId === deleteTarget.id) setSavedId(null);
      setDeleteTarget(null);
      setNotice({
        kind: 'success',
        text: 'Saved report deleted. A trace already open in the workspace remains available locally.',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusyReport('');
    }
  }

  function navigate(next: 'workbench' | 'saved', nextTab?: Tab) {
    generation.current += 1;
    setView(next);
    if (nextTab) setTab(nextTab);
    focusWorkspace();
    setSidebarOpen(false);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" tabIndex={sidebarOpen ? -1 : undefined}>
        Skip to workspace
      </a>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={closeNavigation}
        />
      )}
      <aside
        ref={navigationRef}
        id="workspace-navigation"
        className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}
        aria-label="Main navigation"
      >
        <a className="brand" href="#main-content" onClick={() => navigate('workbench')}>
          <span className="brand-symbol">
            <Icon name="lab" size={23} />
          </span>
          <span>
            Agent Control<span>Lab</span>
          </span>
        </a>
        <div className="sidebar-section-label">Workspace</div>
        <nav className="primary-nav">
          <button
            className={view === 'workbench' && tab !== 'method' ? 'active' : ''}
            onClick={() => navigate('workbench', 'audit')}
          >
            <Icon name="shield" />
            <span>Trace workbench</span>
            <span className="nav-key">01</span>
          </button>
          <button className={view === 'saved' ? 'active' : ''} onClick={() => navigate('saved')}>
            <Icon name="folder" />
            <span>Saved reports</span>
            <span className="nav-count">{savedReports.length}</span>
          </button>
          <button
            className={view === 'workbench' && tab === 'method' ? 'active' : ''}
            onClick={() => navigate('workbench', 'method')}
          >
            <Icon name="info" />
            <span>Method & limits</span>
          </button>
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-section-heading">
          <span className="sidebar-section-label">Example traces</span>
          <span className="tiny-tag">Synthetic</span>
        </div>
        <div className="fixture-nav">
          {fixtures.map((item, index) => (
            <button
              key={item.id}
              className={fixture?.id === item.id && view === 'workbench' ? 'active' : ''}
              onClick={() => chooseTrace(item.trace)}
              disabled={evaluating}
            >
              <span className="fixture-index">{String(index + 1).padStart(2, '0')}</span>
              <span>{item.title}</span>
            </button>
          ))}
        </div>
        <p className="sidebar-note">
          Four scenarios.
          <br />
          Each paired with a permitted control.
        </p>
        <div className="sidebar-bottom">
          <div className="storage-indicator">
            <span
              className={`status-dot ${storageBusy ? 'pending' : storageError ? 'offline' : 'online'}`}
            />
            <strong>
              {storageBusy
                ? 'Connecting storage'
                : storageError
                  ? 'Storage unavailable'
                  : 'Private browser session'}
            </strong>
          </div>
          <p>
            Evaluation runs on this device.
            <br />
            Saved traces expire after {session?.retentionDays ?? 30} days.
          </p>
          <button className="text-button" onClick={() => navigate('workbench', 'method')}>
            About this workspace <Icon name="arrow" size={14} />
          </button>
        </div>
      </aside>

      <div className="main-shell" inert={sidebarOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={navigationToggle}
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-controls="workspace-navigation"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <strong>
              {view === 'saved'
                ? 'Saved reports'
                : tab === 'method'
                  ? 'Method & limits'
                  : 'Trace review'}
            </strong>
          </div>
          <div className="topbar-status">
            <span className="status-dot online" />
            Local evaluation
            <span className="version-tag">v{evaluation?.evaluatorVersion ?? '1.0.0'}</span>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {notice && (
            <div
              className={`notice notice-${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <Icon name={notice.kind === 'success' ? 'check' : 'info'} />
              <p>{notice.text}</p>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {storageError && (
            <div className="storage-warning" role="status">
              <Icon name="info" />
              <p>{storageError}</p>
              <button
                className="text-button"
                disabled={storageBusy}
                onClick={() => void connectStorage()}
              >
                <Icon name="refresh" size={14} />
                {storageBusy ? 'Connecting…' : 'Retry storage'}
              </button>
            </div>
          )}

          {view === 'saved' ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">Your library</span>
                  <h1>Saved reports</h1>
                  <p>Stored traces, ready for another look.</p>
                </div>
                <button
                  className="button button-secondary"
                  onClick={() => void connectStorage()}
                  disabled={storageBusy}
                >
                  <Icon name="refresh" />
                  {storageBusy ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              <div className="privacy-banner">
                <Icon name="shield" />
                <p>
                  Private to this browser’s anonymous cookie. Reports expire after{' '}
                  {session?.retentionDays ?? 30} days; clearing the cookie loses access. Keep an
                  exported copy of anything you need. Limit: {session?.maxReports ?? 20} reports.
                </p>
              </div>
              {storageBusy ? (
                <div className="loading-state" role="status">
                  <span className="loading-dots">•••</span>
                  <p>Loading saved reports</p>
                </div>
              ) : savedReports.length === 0 ? (
                <div className="library-empty">
                  <span className="empty-symbol">
                    <Icon name="folder" size={30} />
                  </span>
                  <h2>
                    {storageError
                      ? 'Your library could not be loaded'
                      : 'Your first report belongs here.'}
                  </h2>
                  <p>
                    {storageError
                      ? 'Your local workspace still works. Reconnect storage to view previously saved traces.'
                      : 'Evaluate an example or import a trace, then save it for a future comparison.'}
                  </p>
                  <button
                    className="button button-primary"
                    onClick={() => (storageError ? void connectStorage() : navigate('workbench'))}
                  >
                    {storageError ? 'Reconnect storage' : 'Open workbench'}
                    <Icon name="arrow" />
                  </button>
                </div>
              ) : (
                <div className="saved-list">
                  {savedReports.map((report) => (
                    <article className="saved-card" key={report.id}>
                      <span className="saved-file-icon">
                        <Icon name="file" size={22} />
                      </span>
                      <div className="saved-description">
                        <h2>
                          <button onClick={() => void openSaved(report.id)} disabled={!!busyReport}>
                            {report.title}
                          </button>
                        </h2>
                        <p>
                          {report.origin === 'fixture' ? 'Fixture (declared)' : 'Imported trace'}
                          <span>·</span>
                          {report.actionCount} actions<span>·</span>
                          {formatDate(report.createdAt)}
                        </p>
                      </div>
                      <div className="saved-actions">
                        <button
                          className="button button-secondary"
                          disabled={!!busyReport}
                          onClick={() => void openSaved(report.id)}
                        >
                          {busyReport === report.id ? 'Working…' : 'Open'}
                          <Icon name="arrow" size={15} />
                        </button>
                        <button
                          className="icon-button"
                          title="Export report"
                          aria-label={`Export ${report.title}`}
                          disabled={!!busyReport}
                          onClick={() => void exportSaved(report.id)}
                        >
                          <Icon name="download" />
                        </button>
                        <button
                          className="icon-button danger-icon"
                          title="Delete report"
                          aria-label={`Delete ${report.title}`}
                          disabled={!!busyReport}
                          onClick={() => {
                            setNotice(null);
                            setDeleteTarget(report);
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">Inspect. Compare. Understand.</span>
                  <h1>Trace workbench</h1>
                  <p>Review tool actions against the authorization available at the time.</p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setImportError('');
                      setImportOpen(true);
                    }}
                    disabled={evaluating}
                  >
                    <Icon name="upload" />
                    Import trace
                  </button>
                </div>
              </div>
              <section className="trace-card" aria-label="Selected trace">
                <div className="trace-card-top">
                  <span className="trace-icon">
                    <Icon name="file" size={24} />
                  </span>
                  <div className="trace-identity">
                    <div className="trace-meta">
                      <span
                        className={`origin-label ${trace.origin === 'fixture' ? 'fixture-label' : ''}`}
                      >
                        {fixture
                          ? 'Educational fixture'
                          : trace.origin === 'fixture'
                            ? 'Declared fixture'
                            : 'Imported trace'}
                      </span>
                      <span className="mono">{trace.events.length} events</span>
                      {savedId && (
                        <span className="saved-label">
                          <Icon name="check" size={13} />
                          Saved
                        </span>
                      )}
                    </div>
                    <h2>{trace.title}</h2>
                    <p>
                      {fixture?.description ??
                        'Imported event sources and authorization records are declared by the uploader.'}
                    </p>
                  </div>
                  <button
                    className="button button-primary evaluate-button"
                    onClick={evaluate}
                    disabled={evaluating}
                  >
                    <Icon name="play" size={16} />
                    {evaluating ? 'Evaluating…' : evaluation ? 'Evaluate again' : 'Evaluate trace'}
                  </button>
                </div>
                <div className="trace-card-bottom">
                  <div className="trace-properties">
                    <span>
                      <span className="property-dot" />
                      Authorization: <strong>{trace.coverage.authorization}</strong>
                    </span>
                    <span>
                      Resource state: <strong>{trace.coverage.resourceState}</strong>
                    </span>
                    <span>{trace.labels?.length ?? 0} reference labels</span>
                  </div>
                  <div className="trace-actions">
                    <button
                      onClick={() => void downloadTrace(trace, evaluation ?? undefined)}
                      className="text-button"
                    >
                      <Icon name="download" size={15} />
                      Export JSON
                    </button>
                    <span className="mini-divider" />
                    <button
                      onClick={() => {
                        setNotice(null);
                        setSaveOpen(true);
                      }}
                      disabled={!!savedId || saving}
                      className="text-button"
                    >
                      <Icon name={savedId ? 'check' : 'plus'} size={15} />
                      {savedId ? 'Saved to library' : 'Save report'}
                    </button>
                  </div>
                </div>
              </section>
              <nav className="view-tabs" aria-label="Report sections">
                <button
                  aria-current={tab === 'audit' ? 'page' : undefined}
                  className={tab === 'audit' ? 'active' : ''}
                  onClick={() => setTab('audit')}
                >
                  <Icon name="file" size={16} />
                  Action review{evaluation && <span>{evaluation.actionCount}</span>}
                </button>
                <button
                  aria-current={tab === 'compare' ? 'page' : undefined}
                  className={tab === 'compare' ? 'active' : ''}
                  onClick={() => setTab('compare')}
                >
                  <Icon name="compare" size={17} />
                  Policy comparison
                </button>
                <button
                  aria-current={tab === 'method' ? 'page' : undefined}
                  className={tab === 'method' ? 'active' : ''}
                  onClick={() => setTab('method')}
                >
                  <Icon name="info" size={17} />
                  Method & limits
                </button>
                <span className="tabs-end">
                  {evaluation ? 'Evaluation complete' : 'Ready when you are'}
                </span>
              </nav>
              {tab === 'method' ? (
                <Method evaluation={evaluation} />
              ) : !evaluation ? (
                <section className="evaluation-empty">
                  <div className="empty-illustration">
                    <span>
                      <Icon name="file" size={22} />
                    </span>
                    <i />
                    <span className="center-node">
                      <Icon name="shield" size={27} />
                    </span>
                    <i />
                    <span>
                      <Icon name="check" size={24} />
                    </span>
                  </div>
                  <span className="eyebrow">A trace is ready to inspect</span>
                  <h2>Follow the evidence, action by action.</h2>
                  <p>
                    Run two deterministic policies on the same trace. See which actions they allow,
                    block, or leave for review—and exactly why.
                  </p>
                  <button
                    className="button button-primary"
                    onClick={evaluate}
                    disabled={evaluating}
                  >
                    <Icon name="play" size={16} />
                    {evaluating ? 'Evaluating…' : 'Evaluate this trace'}
                  </button>
                  <div className="empty-footnote">
                    <Icon name="shield" size={14} />
                    Runs locally. No model calls. No actions executed.
                  </div>
                </section>
              ) : (
                <>
                  {evaluation.warnings.length > 0 && (
                    <details className="evaluation-warnings">
                      <summary>
                        <Icon name="info" size={15} />
                        <span>Audit scope: declared provenance, factual trace only</span>
                        <span className="count-pill">{evaluation.warnings.length} notes</span>
                        <Icon name="chevron" size={14} />
                      </summary>
                      <div>
                        {evaluation.warnings.map((warning, index) => (
                          <p key={index}>{warning}</p>
                        ))}
                      </div>
                    </details>
                  )}
                  {tab === 'audit' ? (
                    <Audit
                      trace={trace}
                      evaluation={evaluation}
                      selectedAction={selectedAction}
                      setSelectedAction={setSelectedAction}
                    />
                  ) : (
                    <Compare evaluation={evaluation} />
                  )}
                </>
              )}
              <footer className="workspace-footer">
                <span>
                  <span className="status-dot neutral" />
                  Offline trace audit · Declared provenance
                </span>
                <p>Audit decisions are not evidence of prevented harm.</p>
              </footer>
            </>
          )}
        </main>
      </div>

      {importOpen && (
        <Dialog title="Import a tool trace" onClose={closeImport}>
          <p className="dialog-description">
            Bring your own JSON trace or re-import an exported report. Imports stay on this device
            until you choose to save.
          </p>
          <div className="file-drop">
            <Icon name="upload" size={25} />
            <div>
              <strong>Choose a JSON file</strong>
              <p>Raw trace: 64 KiB / 200 events. Report bundle: 1 MiB.</p>
            </div>
            <button
              className="button button-secondary"
              disabled={importing}
              onClick={() => fileInput.current?.click()}
            >
              Browse files
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="visually-hidden"
              aria-label="Select trace JSON file"
              disabled={importing}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void readFile(file);
              }}
            />
          </div>
          <label className="input-label" htmlFor="trace-json">
            Or paste trace JSON
          </label>
          <textarea
            id="trace-json"
            className="json-input"
            value={importText}
            disabled={importing}
            onChange={(event) => {
              importGeneration.current += 1;
              setImportText(event.target.value);
              setImportError('');
            }}
            spellCheck={false}
            placeholder={
              '{\n  "schemaVersion": 1,\n  "id": "my-trace",\n  "title": "Customer follow-up",\n  ...\n}'
            }
          />
          <div className="import-helper">
            <span>Use a bundled example to see the supported schema.</span>
            <button className="text-button" onClick={() => void downloadTrace(fixtures[0].trace)}>
              <Icon name="download" size={14} />
              Example JSON
            </button>
          </div>
          {importError && (
            <p className="form-error" role="alert">
              {importError}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button button-secondary" onClick={closeImport}>
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={importing || !importText.trim()}
              onClick={() => void importTrace()}
            >
              <Icon name="upload" size={16} />
              {importing ? 'Verifying…' : 'Import trace'}
            </button>
          </div>
        </Dialog>
      )}
      {saveOpen && (
        <Dialog
          title="Save to your private library"
          busy={saving}
          onClose={() => setSaveOpen(false)}
        >
          <div className="save-trace-name">
            <Icon name="file" size={22} />
            <strong>{trace.title}</strong>
          </div>
          <p className="dialog-description">
            Remove secrets, personal information, and customer identifiers before saving. The trace
            is uploaded; audit results are recomputed from it.
          </p>
          <div className="save-privacy">
            <Icon name="shield" />
            <p>
              Access is tied to an anonymous browser cookie. Saved traces expire after{' '}
              <strong>{session?.retentionDays ?? 30} days</strong>. Clearing or losing the cookie
              loses access. Export a copy if you need a lasting record.
            </p>
          </div>
          <p className="small muted">
            {savedReports.length} of {session?.maxReports ?? 20} report slots used. No account or
            model API key is needed.
          </p>
          {notice?.kind === 'error' && (
            <p className="form-error" role="alert">
              {notice.text}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              disabled={saving}
              onClick={() => setSaveOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => void saveCurrent()}
            >
              <Icon name="plus" size={16} />
              {saving ? 'Saving…' : 'Save trace'}
            </button>
          </div>
        </Dialog>
      )}
      {deleteTarget && (
        <Dialog
          title="Delete saved report?"
          busy={!!busyReport}
          onClose={() => setDeleteTarget(null)}
        >
          <p className="dialog-description">
            “{deleteTarget.title}” will be removed from server storage. An exported copy or a trace
            already open in your workspace is unaffected.
          </p>
          {notice?.kind === 'error' && (
            <p className="form-error" role="alert">
              {notice.text}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              disabled={!!busyReport}
              onClick={() => setDeleteTarget(null)}
            >
              Keep report
            </button>
            <button
              className="button button-danger"
              disabled={!!busyReport}
              onClick={() => void removeSaved()}
            >
              <Icon name="trash" size={16} />
              {busyReport ? 'Deleting…' : 'Delete report'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
