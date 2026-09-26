import { handleCitationsRequest } from './openalex';

// The OpenAlex lookup and its caching live in openalex.ts, which has no framework
// imports so scripts/citations-route-test.mjs can run it under plain Node.
export function GET(request: Request) {
  return handleCitationsRequest(request);
}
