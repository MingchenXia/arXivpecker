import type { ReaderStateSlices } from './reader-state';
import type { ServiceResponse } from './types';

// The local bridge (scripts/codex-bridge.mjs) listens only on this loopback address.
export const bridgeUrl = 'http://127.0.0.1:4318';

/** A failed request to the local bridge or the reader's own API, with the service's message. */
export class ServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
  }
}

type RequestOptions = { signal?: AbortSignal; keepalive?: boolean };
type WithFields<K extends keyof ServiceResponse> = ServiceResponse & { [P in K]-?: NonNullable<ServiceResponse[P]> };

async function readServiceResponse(response: Response): Promise<ServiceResponse> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { error: `The service response could not be read (HTTP ${response.status}).` };
  }
  if (!text.trim()) return { error: `The service returned an empty response (HTTP ${response.status}).` };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ServiceResponse)
      : { error: `The service returned an invalid response (HTTP ${response.status}).` };
  } catch {
    return { error: `The service returned an invalid response (HTTP ${response.status}).` };
  }
}

async function request(url: string, init: RequestInit, failure: string, options: RequestOptions) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: options.signal, keepalive: options.keepalive });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const unreachable = url.startsWith(bridgeUrl)
      ? 'The local arXivpecker bridge is not reachable; start the app with `npm run app`.'
      : 'The reader server is not reachable.';
    throw new ServiceError(`${failure} ${unreachable}`, 0);
  }
  const data = await readServiceResponse(response);
  if (!response.ok) throw new ServiceError(data.error || failure, response.status);
  return data;
}

function requireFields<K extends keyof ServiceResponse>(data: ServiceResponse, failure: string, fields: K[]) {
  for (const field of fields) if (!data[field]) throw new ServiceError(data.error || failure, 200);
  return data as WithFields<K>;
}

/**
 * GETs a bridge route. Throws ServiceError with the bridge's message (or `failure`)
 * when the request fails or the bridge is not running.
 */
export async function bridgeGet<T extends object = ServiceResponse>(
  path: string,
  failure: string,
  options: RequestOptions = {},
): Promise<T> {
  return (await request(`${bridgeUrl}${path}`, { method: 'GET' }, failure, options)) as T;
}

/**
 * POSTs JSON to a bridge route. `require` lists response fields that must be
 * present; the returned type marks them as defined.
 */
export async function bridgePost<K extends keyof ServiceResponse = never>(
  path: string,
  body: unknown,
  failure: string,
  options: RequestOptions & { require?: K[] } = {},
): Promise<WithFields<K>> {
  const data = await request(
    `${bridgeUrl}${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    failure,
    options,
  );
  return requireFields(data, failure, options.require ?? []);
}

/** GETs the reader's own API (for example `/api/arxiv?id=…`). */
export async function readerApiGet<K extends keyof ServiceResponse = never>(
  pathWithQuery: string,
  failure: string,
  options: RequestOptions & { require?: K[] } = {},
): Promise<WithFields<K>> {
  return requireFields(
    await request(pathWithQuery, { method: 'GET' }, failure, options),
    failure,
    options.require ?? [],
  );
}

/** Saves one paper's reader state (notes, marks, expansions, AI answers). */
export function saveReaderState(paperId: string, state: ReaderStateSlices) {
  const body = {
    paperId,
    reader: {
      notes: state.notes.filter((item) => item.paperId === paperId),
      nodeNotes: state.nodeNotes[paperId] ?? {},
      nodeAnswers: state.nodeAnswers[paperId] ?? {},
      expanded: state.expanded[paperId] ?? {},
      marks: state.marks[paperId] ?? {},
    },
  };
  // keepalive lets a save started as the tab closes complete; browsers cap it at 64 KB.
  return bridgePost('/vault/reader', body, 'Reader changes could not be saved.', {
    keepalive: JSON.stringify(body).length < 20_000,
  });
}
