import { useState } from 'react';
import { AIText, MathText } from './math';
import { reportReaderProcess } from '../lib/app';
import { displayUnitLabel, unitId } from '../lib/audit';
import {
  extractCodeBlock,
  leanDraftPrompt,
  leanKey,
  parsePracticeRecord,
  practiceKey,
  proofPracticePrompt,
  readingPath,
} from '../lib/study';
import type { AuditNode, Graph, GraphNode, Paper } from '../lib/types';

type StudyTool = 'path' | 'practice' | 'lean';

type StudyToolsProps = {
  paper: Paper;
  node: AuditNode;
  graph: Graph;
  isUnderstood: (unit: GraphNode) => boolean;
  openUnit: (paperId: string, nodeId: string) => void;
  answers: Record<string, string>;
  saveAnswer: (key: string, value: string) => void;
  askAboutUnit: (node: AuditNode, prompt: string, failure: string) => Promise<string>;
  setProofVisible: (value: boolean) => void;
};

const provable = ['theorem', 'lemma', 'proposition', 'corollary'];

export function StudyTools(props: StudyToolsProps) {
  const { node } = props;
  const [tool, setTool] = useState<StudyTool | null>(null);
  const tools: [StudyTool, string][] = [['path', 'Reading path']];
  if (provable.includes(node.kind) && node.proofText.trim()) tools.push(['practice', 'Practice proof']);
  if (provable.includes(node.kind) || node.kind === 'definition') tools.push(['lean', 'Lean draft']);
  return (
    <section className="assistant-study">
      <header>
        <b>Study</b>
        <nav aria-label="Study tools">
          {tools.map(([id, label]) => (
            <button
              key={id}
              className={tool === id ? 'active' : ''}
              aria-pressed={tool === id}
              onClick={() => setTool(tool === id ? null : id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {tool === 'path' && <ReadingPathView {...props} />}
      {tool === 'practice' && <ProofPractice {...props} />}
      {tool === 'lean' && <LeanDraft {...props} />}
    </section>
  );
}

function ReadingPathView({ paper, node, graph, isUnderstood, openUnit }: StudyToolsProps) {
  const [showUnderstood, setShowUnderstood] = useState(false);
  const targetId = unitId(paper.id, node.id);
  const steps = readingPath(graph, targetId, isUnderstood).filter((step) => step.node.id !== targetId);
  const remaining = steps.filter((step) => !step.understood);
  const visible = showUnderstood ? steps : remaining;
  if (!steps.length)
    return (
      <p className="study-empty">
        No audited prerequisites: this {displayUnitLabel(node).toLowerCase()} can be read on its own.
      </p>
    );
  return (
    <div className="study-path">
      <p>
        {remaining.length
          ? `${remaining.length} unit${remaining.length === 1 ? '' : 's'} to read first, prerequisites before what uses them.`
          : 'Every prerequisite is marked understood.'}{' '}
        {steps.length > remaining.length && (
          <button onClick={() => setShowUnderstood(!showUnderstood)}>
            {showUnderstood ? 'Hide' : 'Show'} {steps.length - remaining.length} understood
          </button>
        )}
      </p>
      <ol aria-label={`Reading path to ${displayUnitLabel(node)}`}>
        {visible.map(({ node: step, understood }) => (
          <li key={step.id} className={understood ? 'understood' : ''}>
            <button onClick={() => openUnit(step.paperId, step.nodeId)}>
              <small>{step.kind}</small>
              <span>
                {displayUnitLabel(step)} · <MathText value={step.title} />
                {step.paperId !== paper.id && <em>{step.paperTitle}</em>}
              </span>
              {understood && <i aria-label="Understood">✓</i>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function useUnitRequest(node: AuditNode, askAboutUnit: StudyToolsProps['askAboutUnit']) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function request(kind: string, prompt: string, failure: string) {
    const processId = `study:${kind}:${node.id}`;
    const detail = displayUnitLabel(node);
    reportReaderProcess({ id: processId, label: `${kind} running`, detail, status: 'running' });
    setBusy(kind);
    setError('');
    try {
      const text = await askAboutUnit(node, prompt, failure);
      reportReaderProcess({ id: processId, label: `${kind} ready`, detail, status: 'complete' });
      return text;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : failure;
      setError(message);
      reportReaderProcess({ id: processId, label: `${kind} stopped`, detail: message, status: 'error' });
      return null;
    } finally {
      setBusy('');
    }
  }
  return { busy, error, request };
}

function ProofPractice({ node, answers, saveAnswer, askAboutUnit, setProofVisible }: StudyToolsProps) {
  const stored = parsePracticeRecord(answers[practiceKey(node.id)]);
  const [attempt, setAttempt] = useState(stored.attempt);
  const [feedback, setFeedback] = useState(stored.feedback);
  const [started, setStarted] = useState(Boolean(stored.attempt));
  const { busy, error, request } = useUnitRequest(node, askAboutUnit);
  const label = displayUnitLabel(node);
  const save = (next: { attempt?: string; feedback?: string }) =>
    saveAnswer(
      practiceKey(node.id),
      JSON.stringify({ attempt, feedback, ...next, updatedAt: new Date().toISOString() }),
    );
  async function run(mode: 'check' | 'hint') {
    const text = await request(
      mode === 'check' ? 'Proof check' : 'Proof hint',
      proofPracticePrompt(label, attempt, mode),
      'The attempt could not be checked.',
    );
    if (text === null) return;
    const next = mode === 'hint' ? `**Hint.** ${text}` : text;
    setFeedback(next);
    save({ attempt, feedback: next });
  }
  if (!started)
    return (
      <div className="study-practice">
        <p>Hide the author proof and write your own; the assistant compares it without giving the proof away.</p>
        <button
          onClick={() => {
            setProofVisible(false);
            setStarted(true);
          }}
        >
          Hide the proof and start
        </button>
      </div>
    );
  return (
    <div className="study-practice">
      <textarea
        aria-label={`Your proof of ${label}`}
        value={attempt}
        onChange={(event) => setAttempt(event.target.value)}
        onBlur={() => attempt !== stored.attempt && save({ attempt })}
        placeholder="Write your proof. LaTeX: $inline$ or $$display$$"
      />
      {attempt.trim() && (
        <div className="assistant-note-preview">
          <MathText value={attempt} block />
        </div>
      )}
      <div className="study-actions">
        <button onClick={() => void run('hint')} disabled={Boolean(busy)}>
          {busy === 'Proof hint' ? 'Thinking…' : 'Hint'}
        </button>
        <button onClick={() => void run('check')} disabled={Boolean(busy) || !attempt.trim()}>
          {busy === 'Proof check' ? 'Comparing…' : 'Compare with the paper'}
        </button>
        <button onClick={() => setProofVisible(true)}>Reveal proof</button>
      </div>
      {error && <p className="proof-step-error">{error}</p>}
      {feedback && (
        <div className="study-feedback">
          <AIText value={feedback} citations={node.citations ?? []} />
        </div>
      )}
    </div>
  );
}

function LeanDraft({ node, answers, saveAnswer, askAboutUnit }: StudyToolsProps) {
  const [draft, setDraft] = useState(answers[leanKey(node.id)] ?? '');
  const [copied, setCopied] = useState(false);
  const { busy, error, request } = useUnitRequest(node, askAboutUnit);
  const code = extractCodeBlock(draft);
  async function run() {
    const text = await request(
      'Lean draft',
      leanDraftPrompt(displayUnitLabel(node)),
      'The Lean draft could not be written.',
    );
    if (text === null) return;
    setDraft(text);
    saveAnswer(leanKey(node.id), text);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="study-lean">
      <p>An uncompiled Lean 4 + Mathlib statement with a sorry proof, as a starting point for formalization.</p>
      <div className="study-actions">
        <button onClick={() => void run()} disabled={Boolean(busy)}>
          {busy ? 'Drafting…' : draft ? 'Redraft' : 'Draft Lean statement'}
        </button>
        {code && (
          <>
            <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy code'}</button>
            <a href={`https://live.lean-lang.org/#code=${encodeURIComponent(code)}`} target="_blank" rel="noreferrer">
              Open in Lean web editor
            </a>
          </>
        )}
      </div>
      {error && <p className="proof-step-error">{error}</p>}
      {draft && (
        <div className="study-feedback">
          <AIText value={draft} />
        </div>
      )}
    </div>
  );
}
