import { MathText } from './math';
import { arxivKey } from '../lib/cited-papers';
import type { WatchRecord } from '../lib/watch';
import type { Paper } from '../lib/types';

export type LibraryWatch = {
  records: Record<string, WatchRecord | null>;
  running: boolean;
  check: () => void;
  daily: boolean;
  setDaily: (value: boolean) => void;
  markSeen: (paperId: string) => void;
  libraryByArxivId: Record<string, string>;
  addCitedPapers: (arxivIds: string[]) => Promise<void>;
};

/** The library's check for new arXiv versions and citing papers. */
export function LibraryWatchBar({ watch }: { watch: LibraryWatch }) {
  const last = Math.max(0, ...Object.values(watch.records).map((record) => Date.parse(record?.checkedAt ?? '') || 0));
  return (
    <div className="library-watch">
      <button onClick={watch.check} disabled={watch.running}>
        {watch.running ? 'Checking…' : 'Check for new versions and citations'}
      </button>
      <span>
        {last
          ? `Last checked ${new Date(last).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
          : 'Not checked yet'}{' '}
        · citations from OpenAlex
      </span>
      <label>
        <input type="checkbox" checked={watch.daily} onChange={(event) => watch.setDaily(event.target.checked)} />
        Check daily
      </label>
    </div>
  );
}

/** Papers that cite this one, newest first, with the ones found since the last look marked. */
export function CitingPapers({ paper, watch }: { paper: Paper; watch: LibraryWatch }) {
  const record = watch.records[paper.id];
  if (!record || (!record.citedByCount && !record.citing.length)) return null;
  const fresh = new Set(record.newIds);
  return (
    <details
      className="library-citations"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open && fresh.size) watch.markSeen(paper.id);
      }}
    >
      <summary>
        Cited by {record.citedByCount}
        {fresh.size > 0 && <b>{fresh.size} new</b>}
      </summary>
      <ul>
        {record.citing.map((work) => {
          const inLibrary = work.arxivId ? watch.libraryByArxivId[arxivKey(work.arxivId)] : '';
          return (
            <li key={work.id} className={fresh.has(work.id) ? 'new' : ''}>
              <a href={work.url} target="_blank" rel="noreferrer">
                <MathText value={work.title} />
              </a>
              <small>
                {[work.authors, work.date.slice(0, 4), work.arxivId && `arXiv:${work.arxivId}`]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
              {work.arxivId &&
                (inLibrary ? (
                  <span>In library</span>
                ) : (
                  <button onClick={() => void watch.addCitedPapers([work.arxivId])}>Add</button>
                ))}
            </li>
          );
        })}
      </ul>
      {record.citedByCount > record.citing.length && <p>Showing the {record.citing.length} most recent.</p>}
    </details>
  );
}
