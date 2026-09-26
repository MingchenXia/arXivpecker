import { handleArxivRequest } from './arxiv-metadata';

// The lookup, throttling, and caching logic lives in arxiv-metadata.ts, which has
// no framework imports so scripts/arxiv-route-test.mjs can run it under plain Node.
export function GET(request: Request) {
  return handleArxivRequest(request);
}
