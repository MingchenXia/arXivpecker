import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { enrichAuditFromTex } from './tex-source.mjs';

// Runs enrichAuditFromTex on a worker thread, so parsing a long paper's TeX
// never blocks the bridge's event loop. This module is also the worker entry.

// Errors cross the thread boundary as plain data; keep the fields callers read
// (message, code, status) and drop anything that cannot be cloned.
function errorPayload(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  const fields = Object.entries(error).filter(
    ([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
  );
  return { ...Object.fromEntries(fields), name: error.name, message: error.message, stack: error.stack };
}

if (!isMainThread && workerData?.texWorker === true) {
  enrichAuditFromTex(workerData.rawText, workerData.primarySource).then(
    (text) => parentPort.postMessage({ text }),
    (error) => parentPort.postMessage({ error: errorPayload(error) }),
  );
}

function enrichAuditFromTexOffThread(rawText, primarySource) {
  let worker;
  try {
    worker = new Worker(new URL(import.meta.url), { workerData: { texWorker: true, rawText, primarySource } });
  } catch {
    // Threads may be unavailable, or the source record may not be cloneable;
    // the same work on this thread is slower to answer but never wrong.
    return enrichAuditFromTex(rawText, primarySource);
  }
  return new Promise((resolve, reject) => {
    let online = false;
    let settled = false;
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      finish();
    };
    worker.once('online', () => {
      online = true;
    });
    worker.once('message', ({ text, error }) =>
      settle(() => (error ? reject(Object.assign(new Error(error.message), error)) : resolve(text))),
    );
    // A worker that fails before it starts running falls back to this thread;
    // one that crashes while parsing reports the failure instead of retrying.
    worker.once('error', (error) =>
      settle(() => (online ? reject(error) : enrichAuditFromTex(rawText, primarySource).then(resolve, reject))),
    );
    worker.once('exit', (code) =>
      settle(() => reject(new Error(`The TeX worker stopped (exit code ${code}) before returning a result.`))),
    );
  });
}

export { enrichAuditFromTexOffThread };
