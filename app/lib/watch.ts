// The library's update and citation watch: what each check found, and what is new
// since the reader last looked.
import type { CitingWork } from '../api/citations/openalex';

export const watchKey = '__watch__';
/** Browser setting: 'off' stops the daily automatic check. */
export const watchDailyKey = 'arxivpecker-watch-daily-v1';

export type WatchRecord = {
  checkedAt: string;
  /** The current arXiv version (with its v-suffix), or '' when arXiv did not say. */
  latestVersion: string;
  citedByCount: number;
  citing: CitingWork[];
  /** Citing works found since the reader last marked the list as seen. */
  newIds: string[];
};

export function parseWatch(value: string | undefined): WatchRecord | null {
  try {
    const parsed = JSON.parse(value || 'null') as Partial<WatchRecord> | null;
    if (!parsed || typeof parsed.checkedAt !== 'string') return null;
    return {
      checkedAt: parsed.checkedAt,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : '',
      citedByCount: typeof parsed.citedByCount === 'number' ? parsed.citedByCount : 0,
      citing: Array.isArray(parsed.citing) ? parsed.citing : [],
      newIds: Array.isArray(parsed.newIds) ? parsed.newIds.filter((id) => typeof id === 'string') : [],
    };
  } catch {
    return null;
  }
}

/**
 * Folds one check into the stored record. The first check sets a baseline, so
 * nothing is "new" until a later check finds it; a failed lookup keeps what the
 * previous check knew.
 */
export function mergeWatch(
  previous: WatchRecord | null,
  found: { latestVersion: string; citations: { citedByCount: number; citing: CitingWork[] } | null },
  checkedAt: string,
): WatchRecord {
  const citations = found.citations ?? { citedByCount: previous?.citedByCount ?? 0, citing: previous?.citing ?? [] };
  const known = new Set((previous?.citing ?? []).map((work) => work.id));
  const fresh =
    previous && found.citations ? citations.citing.filter((work) => !known.has(work.id)).map((work) => work.id) : [];
  const stillListed = new Set(citations.citing.map((work) => work.id));
  return {
    checkedAt,
    latestVersion: found.latestVersion || previous?.latestVersion || '',
    citedByCount: citations.citedByCount,
    citing: citations.citing,
    newIds: [...new Set([...(previous?.newIds ?? []).filter((id) => stillListed.has(id)), ...fresh])],
  };
}

const versionOf = (arxivId: string) => Number(/v(\d+)$/i.exec(arxivId)?.[1] ?? 0);

/** The newer arXiv version the watch found, or '' when the library copy is current. */
export function newerVersion(paperArxivId: string, record: WatchRecord | null) {
  if (!record?.latestVersion) return '';
  const current = versionOf(paperArxivId) || 1;
  return versionOf(record.latestVersion) > current ? record.latestVersion : '';
}
