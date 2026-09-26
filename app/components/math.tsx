import { MouseEvent as ReactMouseEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import { citationAlphaLabel, citationTitle, cleanBibliographicText, cleanRenderedTextFragment, cleanTeXProse, renderMath } from '../lib/tex-text';
import type { CitationReference } from '../lib/types';

export function Latex({ value, small = false }: { value: string; small?: boolean }) {
  const expression = value || '\\text{Add a LaTeX formula}';
  const html = useMemo(() => renderMath(expression, true), [expression]);
  if (!html) return <div className={`${small ? 'text-sm' : 'text-base'} latex-source-fallback`} title="This TeX needs correction before it can be typeset.">{value}</div>;
  return <div className={`${small ? 'text-sm' : 'text-base'} overflow-x-auto text-[#284235]`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export const MathText = memo(function MathText({ value, block = false, citations = [], explicitOnly = false }: { value: string; block?: boolean; citations?: CitationReference[]; explicitOnly?: boolean }) {
  const parts = useMemo(() => {
    const source = cleanTeXProse(value || '');
    // Audits produced from source TeX are asked to preserve $...$ delimiters. The
    // final alternatives also recover compact TeX-like islands when an older audit
    // omitted them, keeping expressions such as χ|det|^s and L_v(χ_v,s)^{-1}
    // together instead of rendering only their superscripts.
    const pattern = explicitOnly ? /(\[\[cite:[^\]]+\]\]|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+?\$|\\\([\s\S]+?\\\))/g : /(\[\[cite:[^\]]+\]\]|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+?\$|\\\([\s\S]+?\\\)|\([^()$\n\[\]]{0,180}(?:\^|_|\\[A-Za-z]+|\{[^}]*\})[^()$\n\[\]]{0,180}\)|[A-Za-z0-9\u0370-\u03ff\\\[\](){}_^|+*/=<>≤≥∈×−,:-]*(?:\^|_|\\|[|≤≥∈×=])[A-Za-z0-9\u0370-\u03ff\\\[\](){}_^|+*/=<>≤≥∈×−,:-]*|(?:Re|Im|GL|SL|Sp|SO|SU|Spec|Hom|Ext|Tor|dim|ker|coker|rank|det|tr|vol|[A-Z])\([^()\s]{1,180}\)(?:(?:_|\^)(?:\{[^{}\n]{1,80}\}|[A-Za-z0-9\u0370-\u03ff+-]))*|[\u0370-\u03ff])/g;
    const result: { text: string; math: boolean; display: boolean; source?: string; citation?: { key: string; locator: string } }[] = [];
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) result.push({ text: cleanRenderedTextFragment(source.slice(cursor, index)), math: false, display: false });
      const token = match[0];
      if (token.startsWith('[[cite:')) { const [key, locator = ''] = token.slice(7, -2).split('|'); result.push({ text: token, math: false, display: false, citation: { key, locator } }); cursor = index + token.length; continue; }
      const display = token.startsWith('$$') || token.startsWith('\\[');
      const expression = token.startsWith('$$') ? token.slice(2, -2) : token.startsWith('$') ? token.slice(1, -1) : token.startsWith('\\(') || token.startsWith('\\[') ? token.slice(2, -2) : token;
      const rendered = renderMath(expression, display);
      result.push(rendered ? { text: rendered, math: true, display, source: token } : { text: cleanRenderedTextFragment(token), math: false, display: false });
      cursor = index + token.length;
    }
    if (cursor < source.length) result.push({ text: cleanRenderedTextFragment(source.slice(cursor)), math: false, display: false });
    return result;
  }, [value, explicitOnly]);
  const Tag = block ? 'div' : 'span';
  return <Tag className={`math-text ${block ? 'math-text-block' : ''}`}>{parts.map((part, index) => part.citation ? <InlineCitation key={index} mention={part.citation} citations={citations} /> : part.math ? <span key={index} className={part.display ? 'math-display' : 'math-inline'} data-source={part.source} dangerouslySetInnerHTML={{ __html: part.text }} /> : <span key={index}>{part.text}</span>)}</Tag>;
});

type AITextBlock = { kind: 'paragraph' | 'heading' | 'quote' | 'bullet' | 'number' | 'code'; text: string; marker?: string };

function AIRichInline({ value, citations }: { value: string; citations: CitationReference[] }) {
  const parts = value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).filter(Boolean);
  return <>{parts.map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}><MathText value={part.slice(2, -2)} citations={citations} /></strong> : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : <MathText key={index} value={part} citations={citations} />)}</>;
}

export function AIText({ value, citations = [] }: { value: string; citations?: CitationReference[] }) {
  const blocks = useMemo(() => {
    const result: AITextBlock[] = []; let paragraph: string[] = []; let code: string[] = []; let inCode = false;
    const flushParagraph = () => { if (paragraph.length) result.push({ kind: 'paragraph', text: paragraph.join(' ') }); paragraph = []; };
    const flushCode = () => { if (code.length) result.push({ kind: 'code', text: code.join('\n') }); code = []; };
    for (const rawLine of (value || '').replace(/\r/g, '').split('\n')) {
      const line = rawLine.trim();
      if (/^```/.test(line)) { if (inCode) flushCode(); else flushParagraph(); inCode = !inCode; continue; }
      if (inCode) { code.push(rawLine); continue; }
      if (!line) { flushParagraph(); continue; }
      const heading = line.match(/^#{1,4}\s+(.+)$/); const quote = line.match(/^>\s?(.*)$/); const bullet = line.match(/^[-*]\s+(.+)$/); const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
      if (heading) { flushParagraph(); result.push({ kind: 'heading', text: heading[1] }); }
      else if (quote) { flushParagraph(); result.push({ kind: 'quote', text: quote[1] }); }
      else if (bullet) { flushParagraph(); result.push({ kind: 'bullet', text: bullet[1], marker: '•' }); }
      else if (numbered) { flushParagraph(); result.push({ kind: 'number', text: numbered[2], marker: numbered[1] }); }
      else paragraph.push(line);
    }
    flushParagraph(); flushCode(); return result;
  }, [value]);
  return <div className="ai-rich-text">{blocks.map((block, index) => block.kind === 'heading' ? <h4 key={index}><AIRichInline value={block.text} citations={citations} /></h4> : block.kind === 'quote' ? <blockquote key={index}><AIRichInline value={block.text} citations={citations} /></blockquote> : block.kind === 'bullet' || block.kind === 'number' ? <div key={index} className="ai-rich-list-item"><span>{block.kind === 'number' ? `${block.marker}.` : block.marker}</span><p><AIRichInline value={block.text} citations={citations} /></p></div> : block.kind === 'code' ? <pre key={index}>{block.text}</pre> : <p key={index}><AIRichInline value={block.text} citations={citations} /></p>)}</div>;
}

function InlineCitation({ mention, citations }: { mention: { key: string; locator: string }; citations: CitationReference[] }) {
  const [pinned, setPinned] = useState(false); const [hovered, setHovered] = useState(false); const [copied, setCopied] = useState(false); const rootRef = useRef<HTMLSpanElement>(null); const hoverTimerRef = useRef<number | null>(null);
  useEffect(() => { if (!pinned) return; const closeOutside = (event: globalThis.MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setPinned(false); }; const closeEscape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setPinned(false); }; document.addEventListener('click', closeOutside, true); document.addEventListener('keydown', closeEscape); return () => { document.removeEventListener('click', closeOutside, true); document.removeEventListener('keydown', closeEscape); }; }, [pinned]);
  useEffect(() => () => { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); }, []);
  function beginHover() { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; setHovered(true); }
  function endHover() { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = window.setTimeout(() => { setHovered(false); hoverTimerRef.current = null; }, 360); }
  const citation = citations.find((item) => item.key === mention.key && item.locator === mention.locator) ?? citations.find((item) => item.key === mention.key);
  const locator = mention.locator || citation?.locator || '';
  const specificResult = /\b(theorem|lemma|proposition|corollary|definition|claim|result|thm\.?|lem\.?|prop\.?)\b/i.test(locator);
  const preview = specificResult && citation?.statement ? citation.statement : citationTitle(citation, mention.key);
  const sourceLabel = `[${citationAlphaLabel(citation, mention.key)}${locator ? `, ${locator}` : ''}]`;
  const copyText = [sourceLabel, citation?.authors, citationTitle(citation, mention.key), specificResult ? preview : '', citation?.url].filter(Boolean).map((item) => cleanBibliographicText(String(item))).join('\n');
  async function copyCitation(event: ReactMouseEvent) { event.stopPropagation(); await navigator.clipboard.writeText(copyText); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
  return <span ref={rootRef} className={`inline-citation ${pinned ? 'citation-pinned' : ''} ${hovered ? 'citation-hover-active' : ''}`} data-source={sourceLabel} tabIndex={0} onMouseEnter={beginHover} onMouseLeave={endHover} onClick={(event) => { event.stopPropagation(); setPinned(true); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPinned(true); } }}>{sourceLabel}<span className="citation-hover-card" role={pinned ? 'dialog' : 'tooltip'} aria-label={`Citation ${sourceLabel}`} onMouseEnter={beginHover} onMouseLeave={endHover}><span className="citation-hover-head"><b>{specificResult ? locator : 'Cited paper'}</b>{pinned && <button onClick={(event) => { event.stopPropagation(); setPinned(false); }} aria-label="Close citation preview">×</button>}</span><span className="citation-copyable"><MathText value={preview} /></span>{citation?.authors && <em className="citation-hover-authors">{cleanBibliographicText(citation.authors)}</em>}{pinned && <span className="citation-hover-actions"><button onClick={(event) => void copyCitation(event)}>{copied ? 'Copied' : 'Copy citation'}</button></span>}</span></span>;
}
