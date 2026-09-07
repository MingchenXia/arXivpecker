const ARXIV_ID = /(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i;

export function normalizeArxivId(value) {
  if (typeof value !== 'string') return '';

  let decoded;
  try {
    decoded = decodeURIComponent(value.trim());
  } catch {
    // A malformed percent escape is an invalid identifier, not a server error.
    return '';
  }

  const cleaned = decoded
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf(?:\?.*)?$/i, '')
    .replace(/[?#].*$/, '');
  return cleaned.match(ARXIV_ID)?.[0] ?? '';
}
