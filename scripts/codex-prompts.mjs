// Prompts and structured-output schemas sent to the local Codex app-server.

function latexConversionPrompt({ paper, pdfPath = '' }) {
  return `Convert the complete primary PDF at ${pdfPath || `https://arxiv.org/pdf/${paper.arxivId}`} into a faithful standalone LaTeX document.

This is a transcription task, not a rewrite. Read every page. Preserve the title, authors, abstract, section hierarchy, theorem/definition/lemma/proposition environments, equation structure, labels, references, proofs, footnotes, bibliography, and mathematical notation. Do not improve, complete, or silently correct the mathematics. Mark illegible fragments explicitly with \\text{[unreadable in source]}. Add a short LaTeX comment before each page transition in the form "% PDF page N" when you can identify it.

Return only one complete compilable LaTeX document, beginning with \\documentclass and ending with \\end{document}. Do not use Markdown fences or add commentary outside the document.`;
}

function extractLatexDocument(text, paper = null) {
  const clean = String(text || '').trim().replace(/^```(?:latex|tex)?\s*/i, '').replace(/\s*```$/i, '');
  const start = clean.indexOf('\\documentclass');
  const endMarker = '\\end{document}';
  const end = clean.lastIndexOf(endMarker);
  if (start < 0 || end < start) throw new Error('Codex did not return a complete LaTeX document.');
  const document = clean.slice(start, end + endMarker.length).trim();
  if (Buffer.byteLength(document, 'utf8') > 12 * 1024 * 1024) throw new Error('The AI-converted LaTeX document exceeds the local safety limit.');
  const body = document.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/)?.[1]?.trim() ?? '';
  const refusal = /cannot (?:provide|transcribe|convert)|can't (?:provide|transcribe|convert)|copyright(?:ed)? paper|unable to (?:access|provide|transcribe)|I (?:can|could) help (?:with|you) (?:a )?(?:short|brief|summary)/i;
  const hasStructure = /\\(?:section|chapter|part)\*?\s*\{|\\begin\{(?:abstract|theorem|lemma|proposition|definition|proof)\}/.test(body);
  if (refusal.test(body) || Buffer.byteLength(body, 'utf8') < 2_000 || !hasStructure) {
    const label = paper?.arxivId ? `arXiv:${paper.arxivId}` : 'this paper';
    throw new Error(`AI could not create a complete LaTeX reading source for ${label}. Upload the author TeX (use ZIP for a multi-file project) or the original PDF and try again.`);
  }
  return `${document}\n`;
}
function makeAuditSchema() {
  const anchor = {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'page', 'confidence'],
    properties: {
      label: { type: 'string' },
      page: { type: ['integer', 'null'] },
      confidence: { enum: ['verified', 'approximate', 'unverified'] },
    },
  };
  const node = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'label', 'title', 'statement', 'proofText', 'citations', 'status', 'anchor', 'role', 'dependencies', 'proofSketch', 'whyItMatters', 'expandable'],
    properties: {
      id: { type: 'string' },
      kind: { enum: ['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'conjecture', 'proof', 'equation', 'remark', 'example', 'section', 'external-result'] },
      label: { type: 'string' },
      title: { type: 'string' },
      statement: { type: 'string' },
      proofText: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'locator', 'statement', 'definitions'],
          properties: { key: { type: 'string' }, locator: { type: 'string' }, statement: { type: 'string' }, definitions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['notation', 'definition', 'source'], properties: { notation: { type: 'string' }, definition: { type: 'string' }, source: { type: 'string' } } } } },
        },
      },
      status: { enum: ['verified', 'needs-verification', 'unavailable'] },
      anchor,
      role: { type: 'string' },
      dependencies: { type: 'array', items: { type: 'string' } },
      proofSketch: { type: 'array', items: { type: 'string' } },
      whyItMatters: { type: 'string' },
      expandable: { type: 'boolean' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['audit', 'nodes', 'readingPaths', 'crossPaperLinks', 'openQuestions', 'editorialCorrections'],
    properties: {
      audit: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceStatus', 'sourceSummary', 'centralQuestion', 'mainContribution', 'verificationWarnings'],
        properties: {
          sourceStatus: { enum: ['full-text-read', 'partial-text-read', 'blocked'] },
          sourceSummary: { type: 'string' },
          centralQuestion: { type: 'string' },
          mainContribution: { type: 'string' },
          verificationWarnings: { type: 'array', items: { type: 'string' } },
        },
      },
      nodes: { type: 'array', minItems: 1, items: node },
      readingPaths: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['goal', 'nodeIds', 'reason'],
          properties: { goal: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
        },
      },
      crossPaperLinks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['fromNodeId', 'targetPaperId', 'targetNodeId', 'relation', 'rationale'],
          properties: {
            fromNodeId: { type: 'string' },
            targetPaperId: { type: 'string' },
            targetNodeId: { type: 'string' },
            relation: { enum: ['uses', 'extends', 'background', 'contrasts'] },
            rationale: { type: 'string' },
          },
        },
      },
      openQuestions: { type: 'array', items: { type: 'string' } },
      editorialCorrections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['nodeId', 'field', 'original', 'replacement', 'rationale', 'confidence'], properties: { nodeId: { type: 'string' }, field: { enum: ['statement', 'proofText'] }, original: { type: 'string' }, replacement: { type: 'string' }, rationale: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] } } } },
    },
  };
}

function makeEditorialSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['hasIssue', 'replacement', 'rationale', 'confidence'],
    properties: {
      hasIssue: { type: 'boolean' },
      replacement: { type: 'string' },
      rationale: { type: 'string' },
      confidence: { enum: ['high', 'medium', 'low'] },
    },
  };
}

function makeVersionComparisonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'changedUnits', 'proofChanges', 'notationChanges', 'editorialChanges', 'dependencyImpact', 'readingRecommendation', 'warnings'],
    properties: {
      summary: { type: 'string' },
      changedUnits: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['label', 'changeType', 'before', 'after', 'significance', 'dependencyImpact'],
          properties: {
            label: { type: 'string' },
            changeType: { enum: ['added', 'removed', 'strengthened', 'weakened', 'corrected', 'reorganized', 'wording'] },
            before: { type: 'string' },
            after: { type: 'string' },
            significance: { enum: ['mathematical', 'proof-level', 'expository', 'uncertain'] },
            dependencyImpact: { type: 'string' },
          },
        },
      },
      proofChanges: { type: 'array', items: { type: 'string' } },
      notationChanges: { type: 'array', items: { type: 'string' } },
      editorialChanges: { type: 'array', items: { type: 'string' } },
      dependencyImpact: { type: 'array', items: { type: 'string' } },
      readingRecommendation: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  };
}

function auditPrompt({ paper, profile, localInventory, primarySource, correctnessAudit = true, detailedAudit = true, updateContext = null, continuation = false }) {
  const libraryContext = localInventory.length
    ? JSON.stringify(localInventory, null, 2)
    : 'No other audited papers are available in the local vault yet.';
  const sourceInstructions = primarySource?.kind === 'tex'
    ? `A local ${primarySource.origin === 'reader-upload' ? 'reader-supplied' : 'arXiv'} TeX source bundle has already been acquired. Read it before doing anything else.
- main TeX entry: ${primarySource.entryFile}
- source directory: ${primarySource.sourceDirectory}
- TeX files available: ${primarySource.fileCount}

Prefer these local TeX files over the PDF: preserve theorem environment labels, \\label/\\ref relationships, section structure, equations, and \\input/\\include dependencies. Use the PDF only to verify pagination or material absent from the source bundle.`
    : primarySource?.kind === 'ai-tex'
      ? `The arXiv source bundle had no usable TeX. At the reader's request, local AI transcribed the complete PDF into an editable LaTeX working source.
- AI-generated LaTeX entry: ${primarySource.entryFile}
- source directory: ${primarySource.sourceDirectory}

Read that local LaTeX document first, but treat the original PDF at https://arxiv.org/pdf/${paper.arxivId} as authoritative. Verify statements against the PDF whenever the conversion may be ambiguous. State clearly in sourceSummary that the LaTeX is an AI transcription, not author-supplied source.`
      : primarySource?.kind === 'uploaded-pdf'
        ? `The reader supplied the primary PDF directly. Read the complete local PDF at ${primarySource.entryFile}. Treat this uploaded file as authoritative and do not attempt to substitute an arXiv document.`
        : `The arXiv TeX source could not be used (${primarySource?.error || 'unavailable'}). Fall back to the primary PDF at https://arxiv.org/pdf/${paper.arxivId}.`;
  const proofCaptureInstructions = primarySource?.kind === 'tex' || primarySource?.kind === 'ai-tex'
    ? `The host application deterministically attaches complete theorem statements and proof environments from the local LaTeX tree after your turn. Set proofText to an empty string for every node; spend the response budget on accurate dependency analysis and proofSketch explanations. Do not warn about proof payload length.`
    : `For every theorem, lemma, proposition, corollary, and proof node, statement must be a source-faithful transcription of the complete printed statement, not a summary, and proofText must contain the complete proof from the PDF, including all equations, cases, and cited intermediate results. Do not shorten a proof. Use an empty proofText only when the source genuinely has no proof or the complete proof cannot be accessed, and explain that limitation in the verification warnings.`;
  const correctnessInstructions = correctnessAudit
    ? `CORRECTNESS AUDIT REQUESTED: Treat this as an adversarial mathematical referee pass, not a summary. For every formal environment, actively check whether the statement is well-formed under the declared hypotheses and whether its proof supports the exact conclusion. Try the smallest natural examples and counterexamples against universal claims. Check every division, normalization, extension across a singular set, change of quantifiers, use of compactness or a maximum principle, and transition between pointwise, local, and global assertions. In geometry and sheaf theory, explicitly distinguish a locally free sheaf from a subbundle, a sheaf injection from a fibrewise injection or nowhere-vanishing section, and an arbitrary subsheaf from a saturated one; verify that any quotient has the regularity the proof uses. Trace dependencies, inspect cited prerequisites when accessible, and use status "verified" only when this check succeeds. Use "needs-verification" for a specific gap, ambiguity, unchecked external dependency, or possible error, explain the exact failure and a concrete test case in role or verificationWarnings, and propagate the warning to downstream results that use it. Never repair or silently strengthen an argument.`
    : `CORRECTNESS AUDIT NOT REQUESTED: Preserve the complete document structure and source text, build logical dependencies, and mark source-transcribed environments as verified only in the limited sense that their text was located in the primary source. Do not claim that the mathematics or proof has been checked for correctness.`;
  const depthInstructions = detailedAudit
    ? `DETAILED AUDIT MODE: Build a retrieval queue for every citation locator that names a theorem, lemma, proposition, corollary, definition, equation, section, or numbered result. For each queue item, resolve the cited paper from its bibliography record, fetch the cited paper's primary TeX source when it is on arXiv (use its PDF only when TeX is unavailable), search that source for the exact locator, and recover the complete statement before finishing this audit. Also recover every nearby definition needed to interpret its nonstandard notation and hypotheses. Populate citations.statement and citations.definitions only with material verified in that cited primary source. Continue through the full queue within the available audit time instead of deferring retrieval to a later question. Do not return a placeholder saying that a record is not cached; either provide verified source detail or leave the field empty and give a precise verification warning naming what access or locator failed.`
    : `STANDARD AUDIT MODE: Preserve citation keys, locators, titles, and direct primary-source links, but do not spend the audit budget following every external theorem.`;
  const versionInstructions = updateContext
    ? `VERSION UPDATE CONTEXT: This paper is replacing an earlier locally audited arXiv version. Read and audit the new primary source independently, then use this compact comparison only to make sure changed assumptions, results, proofs, notation, citations, and downstream dependencies receive special scrutiny. Do not copy stale statements or proof text from the previous audit. Do not discard a new source unit merely because it has no predecessor.\n${JSON.stringify(updateContext, null, 2)}`
    : '';
  const continuationInstructions = continuation
    ? `RESUME SAVED AUDIT: This is a continuation of an unfinished audit in this same Codex thread. Keep the primary-source work already completed in this conversation, then continue from any sections, citations, proof checks, or JSON fields that remain incomplete. Return one complete replacement audit JSON document for the whole paper, not a progress note or a partial delta. Do not start a new audit thread or discard verified work merely because this turn resumed after a browser or computer restart.`
    : '';
  return `You are arXivpecker's mathematical-paper audit engine. Work for a ${profile.level} interested in ${profile.areas.join(', ')}, whose goal is "${profile.goal}".

FIRST: Read the WHOLE primary source before making a guide. Inspect the introduction, every section heading, all named definitions, assumptions, propositions, lemmas, theorems, corollaries, conjectures, and the proof architecture. Do not use only the abstract. If full text is unavailable, report partial-text-read or blocked and do not invent missing mathematical statements.

${sourceInstructions}

Paper:
- title: ${paper.title}
- authors: ${paper.authors}
- arXiv id: ${paper.arxivId}
- abstract URL: https://arxiv.org/abs/${paper.arxivId}
- PDF URL: https://arxiv.org/pdf/${paper.arxivId}
- imported abstract: ${paper.abstract}

Existing audited papers in this reader's local vault:
${libraryContext}

THEN: Produce a source-anchored audit that will become the durable context for later questions about individual theorems. Each node must be a distinct clickable document unit. Include the exact printed label and page whenever available. The id is internal only; never copy a TeX \\label slug such as thm101 into the reader-facing label or title. Mark a statement verified only when you saw it in the primary source. Dependencies must reference other internal node ids and point only from a result to prerequisites. Include no made-up formulas, theorem statements, page numbers, or citations.

${proofCaptureInstructions}

${correctnessInstructions}

${depthInstructions}

${versionInstructions}

${continuationInstructions}

The proofSketch is a separate short AI explanation of the proof route; it never substitutes for the complete source proof shown to the reader.

Perform a conservative editorial pass during this same initial audit. Put only obvious, source-verifiable typographical corrections in editorialCorrections: malformed notation, a clear misspelling, an inconsistent symbol, or an unmistakable local reference typo. Each correction must name an existing nodeId and either statement or proofText, preserve the exact original fragment, supply the complete corrected field, and explain the evidence. Never use this mechanism for stylistic rewriting, proof completion, strengthening a claim, changing hypotheses, or uncertain mathematics. When doubt remains, make no correction and add a verification warning instead. These corrections become reversible highlighted working-layer edits; the author source remains preserved.

For every explicit \\cite in a node's statement or proof, add a citations entry using the exact bibliography key and optional locator text. During this initial audit—not deferred until a later reader question—resolve every citation that names a specific Theorem, Lemma, Proposition, Corollary, Definition, or numbered result whenever primary-source access makes that possible. Transcribe the complete exact cited statement into citations.statement. Then inspect the cited source's surrounding definitions and notation sections: add one citations.definitions item for every nonstandard symbol, object, map, space, hypothesis abbreviation, or convention needed to understand that statement. Each item contains notation, its precise definition, and a source locator such as “Definition 2.1” or “p. 7”. Do not infer a definition from the current paper when the cited paper defines it differently. A general paper citation has an empty statement and an empty definitions array; the reader will preview its bibliographic title. Never invent an external theorem statement or notation definition. If a specifically located result or necessary definition cannot be verified, leave the unavailable field empty and add a verification warning naming the key and locator.

In every JSON string, wrap complete inline mathematical expressions in $...$ and display expressions in $$...$$. Keep each expression together: for example $\\chi|\\det|^s$ and $L_v(\\chi_v,s+n-(k+1)/2)^{-1}$. Never emit a formula partly as prose and partly as LaTeX.

Cross-paper links are optional but useful. Return one only when this paper explicitly uses, extends, contrasts with, or needs background from a unit listed in the existing local vault. Use the exact paperId and node id supplied above; never guess a link. Otherwise return an empty crossPaperLinks array.

Return JSON only, matching the supplied schema. The source summary must state exactly what was read and any limitations.`;
}

function nodeQuestionPrompt({ paper, node, question, continuation = true }) {
  const conversationContext = continuation
    ? 'The full-paper audit from the previous turn is the controlling context.'
    : `This is a new reader conversation created from a portable audit that has no reusable Codex thread. Treat the selected audited unit below as the controlling structured context. Re-open the local paper source when broader definitions, proof dependencies, or exact wording are needed.`;
  return `${conversationContext} The reader selected this audited document unit:
${JSON.stringify(node)}

Paper: ${paper.title} (arXiv:${paper.arxivId})
${paper.folder ? `Local reader folder: proofroom-library/${paper.folder}. Check attachments/references for reader-supplied PDFs, TeX, or BibTeX before treating a cited source as unavailable.` : ''}
Reader question: ${question}

Answer only about this selected unit and its declared dependency chain. Refer to results by their printed names (for example, “Theorem 3.5”), never by internal ids or TeX label slugs. Start with the source anchor and verification status. Preserve uncertainty: if the audit does not establish a claim, say what needs checking in the primary paper. Explain at the reader's configured level; use the complete proofText as the source when expanding a proof. Do not silently replace the paper's theorem by a stronger or simpler statement.

If the reader asks to retrieve or expand a cited result, follow the citation URL or exact-title lookup in the selected unit, locate the named theorem/lemma/proposition in the cited primary paper, and return: (1) the complete cited statement, (2) the complete original proof when accessible, and (3) a clearly separated reader-level explanation. Never invent a missing proof. Say exactly which primary source and result locator you verified.`;
}

function paperQuestionPrompt({ paper, currentNode, question, continuation = true }) {
  const sourceHint = paper.folder ? `The local paper folder is proofroom-library/${paper.folder}; prefer its attachments/source TeX tree over the PDF whenever it is present, and inspect attachments/references for reader-supplied cited sources.` : `Use the primary source already inspected in the full-paper audit.`;
  const conversationContext = continuation
    ? 'The complete paper and the durable full-paper audit from the first turn are the controlling context for this conversation.'
    : 'This is a new reader conversation created from a portable audit that has no reusable Codex thread. Inspect the local primary source and use the paper metadata below as the controlling context.';
  return `${conversationContext}

Paper: ${paper.title} (arXiv:${paper.arxivId})
${sourceHint}
${currentNode ? `The reader is currently near this unit, but the question may concern any part of the paper:\n${JSON.stringify(currentNode)}` : ''}

Reader question: ${question}

Answer across the whole paper, not merely the current unit. Use the author text, its definitions, theorem statements, complete proofs, bibliography, and audited logical dependencies as context. Re-open the local TeX source when exact wording or a proof step matters. Distinguish verbatim source content from your explanation, refer to results by printed names rather than internal ids or TeX labels, preserve uncertainty, and render mathematics in LaTeX. If the answer depends on an external cited result, identify the exact source and locator; retrieve its original statement and proof when the reader asks for expansion, and never invent inaccessible material.`;
}

function editorialPrompt({ paper, node }) {
  return `The full-paper audit from the previous turn is controlling context. Inspect the primary source again at this selected unit before suggesting any change.\n\nPaper: ${paper.title} (arXiv:${paper.arxivId})\nSelected unit: ${JSON.stringify(node)}\n\nAct as a source-preserving mathematical editor. Identify only a genuine typo, notation inconsistency, or unambiguous local wording error. Do not rewrite for style, strengthen a claim, fill in a proof, or change a theorem's mathematics. Return JSON only with keys: hasIssue (boolean), replacement (string), rationale (string), confidence ("high"|"medium"|"low"). If no clear error is verifiable from the primary source, use hasIssue:false and an empty replacement.`;
}

function comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile, readerContext = null }) {
  const describe = (version, source) => source?.kind === 'tex'
    ? `${version}: local TeX entry ${source.entryFile} (source directory ${source.sourceDirectory})`
    : `${version}: TeX unavailable; inspect https://arxiv.org/pdf/${version} (${source?.error || 'PDF fallback'})`;
  return `You are comparing two primary-source versions of the same mathematical paper for a ${profile.level} reader whose goal is "${profile.goal}".

Paper: ${paper.title}
Version A: ${describe(fromVersion, fromSource)}
Version B: ${describe(toVersion, toSource)}

Read both complete sources before reporting differences. Prefer the local TeX trees. Resolve \\input and \\include files, theorem environments, labels, references, equations, and bibliography changes. Use a structural mathematical comparison, not a raw line-by-line diff.

${readerContext ? `The reader has durable work attached to Version A. Use it only to prioritize the comparison and explicitly mention changed units that could affect these notes, marks, or edits; never reinterpret the reader's text as author text:\n${JSON.stringify(readerContext, null, 2)}` : ''}

Prioritize changes to definitions, assumptions, theorem/lemma/proposition statements, proof steps, counterexamples, hypotheses, conclusions, and logical dependencies. Distinguish a genuine strengthening or weakening from wording, renumbering, or moved text. For each changed unit, provide a compact before/after paraphrase and explain how its prerequisite or downstream dependency chain changes. Every change array must contain actual changes only: when a category is unchanged, return an empty array rather than an item saying "none" or "unchanged". Never infer a mathematical change from formatting alone. Put uncertain cases in warnings.

Return JSON only, matching the supplied schema. The reading recommendation should tell a mathematician exactly which changed results or proofs deserve rereading.`;
}

export { auditPrompt, comparisonPrompt, editorialPrompt, extractLatexDocument, latexConversionPrompt, makeAuditSchema, makeEditorialSchema, makeVersionComparisonSchema, nodeQuestionPrompt, paperQuestionPrompt };
