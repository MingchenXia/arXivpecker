import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VAULT_VERSION = 1;

function slug(value, limit = 64) {
  return String(value || 'untitled-paper')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/g, '') || 'untitled-paper';
}

function arxivStem(arxivId) {
  return String(arxivId || 'local')
    .replace(/^arXiv:/i, '')
    .replace(/v\d+$/i, '')
    .replace(/[^a-zA-Z0-9.]+/g, '-');
}

function stablePaperId(paper) {
  return `arxiv-${arxivStem(paper.arxivId)}`;
}

function compactPaper(paper) {
  return {
    id: String(paper.id),
    title: String(paper.title),
    authors: String(paper.authors || 'Unknown author'),
    category: String(paper.category || 'math.GN'),
    arxivId: String(paper.arxivId),
    abstract: String(paper.abstract || ''),
    state: ['To read', 'Reading', 'Read'].includes(paper.state) ? paper.state : 'To read',
    tags: Array.isArray(paper.tags) ? paper.tags.map(String) : [],
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

function readmeFor(paper) {
  return `# ${paper.title}\n\n` +
    `- **arXiv:** ${paper.arxivId}\n` +
    `- **Authors:** ${paper.authors}\n` +
    `- **Category:** ${paper.category}\n\n` +
    `This folder is managed by arXivpecker. It keeps the source record, full-paper audit, reader state, and cross-paper links together.\n`;
}

export class PaperVault {
  constructor(root) {
    this.root = root;
    this.graphDirectory = path.join(root, '_graph');
    this.indexFile = path.join(this.graphDirectory, 'index.json');
    this.graphFile = path.join(this.graphDirectory, 'graph.json');
    this.profileFile = path.join(root, 'profile.json');
  }

  async ensure() {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.graphDirectory, { recursive: true });
    const index = await readJson(this.indexFile, null);
    if (!index) await writeJson(this.indexFile, { version: VAULT_VERSION, updatedAt: new Date().toISOString(), papers: [], links: [] });
  }

  async index() {
    await this.ensure();
    const index = await readJson(this.indexFile, { version: VAULT_VERSION, updatedAt: new Date().toISOString(), papers: [], links: [] });
    const savedPapers = Array.isArray(index.papers) ? index.papers : [];
    const folders = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'));
    const discovered = [];
    for (const entry of folders) {
      const paper = await readJson(path.join(this.root, entry.name, 'paper.json'), null);
      if (!paper?.id || !paper?.title || !paper?.arxivId) continue;
      const previous = savedPapers.find((record) => record.folder === entry.name || record.id === String(paper.id));
      discovered.push({ id: String(paper.id), arxivId: String(paper.arxivId), folder: entry.name, title: String(paper.title), updatedAt: String(paper.updatedAt || previous?.updatedAt || new Date().toISOString()), createdAt: String(paper.createdAt || previous?.createdAt || new Date().toISOString()) });
    }
    const byId = new Map(discovered.map((record) => [record.id, record]));
    const ordered = savedPapers.map((record) => byId.get(record.id)).filter(Boolean);
    const seen = new Set(ordered.map((record) => record.id));
    const papers = [...ordered, ...discovered.filter((record) => !seen.has(record.id)).sort((left, right) => left.title.localeCompare(right.title))];
    const normalized = { ...index, papers, links: Array.isArray(index.links) ? index.links : [] };
    const priorShape = savedPapers.map(({ id, folder, title, arxivId }) => ({ id, folder, title, arxivId }));
    const nextShape = papers.map(({ id, folder, title, arxivId }) => ({ id, folder, title, arxivId }));
    if (JSON.stringify(priorShape) !== JSON.stringify(nextShape)) await this.writeIndex(normalized);
    return normalized;
  }

  async writeIndex(index) {
    await writeJson(this.indexFile, { ...index, version: VAULT_VERSION, updatedAt: new Date().toISOString() });
  }

  folderName(paper) {
    return `arxiv-${arxivStem(paper.arxivId)}--${slug(paper.title, 56)}`;
  }

  paperDirectory(record) {
    return path.join(this.root, record.folder);
  }

  async createDirectories(directory) {
    await Promise.all([
      mkdir(directory, { recursive: true }),
      mkdir(path.join(directory, 'attachments'), { recursive: true }),
      mkdir(path.join(directory, 'exports'), { recursive: true }),
      mkdir(path.join(directory, 'editions', 'working'), { recursive: true }),
    ]);
  }

  async upsertPaper(incoming) {
    const paper = compactPaper({ ...incoming, id: stablePaperId(incoming) });
    const index = await this.index();
    const existing = index.papers.find((item) => item.id === paper.id || item.arxivId === paper.arxivId);
    const record = {
      id: paper.id,
      arxivId: paper.arxivId,
      folder: existing?.folder ?? this.folderName(paper),
      title: paper.title,
      updatedAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const directory = this.paperDirectory(record);
    await this.createDirectories(directory);
    const oldPaper = await readJson(path.join(directory, 'paper.json'), {});
    await writeJson(path.join(directory, 'paper.json'), { ...oldPaper, ...paper, folder: record.folder, updatedAt: record.updatedAt, createdAt: oldPaper.createdAt ?? record.createdAt, source: { ...(oldPaper.source ?? {}), abstractUrl: `https://arxiv.org/abs/${paper.arxivId}`, pdfUrl: `https://arxiv.org/pdf/${paper.arxivId}`, texUrl: `https://export.arxiv.org/e-print/${paper.arxivId}` } });
    await writeFile(path.join(directory, 'README.md'), readmeFor(paper), 'utf8');
    const patchesFile = path.join(directory, 'editions', 'working', 'patches.json');
    const patches = await readJson(patchesFile, null);
    if (!patches) await writeJson(patchesFile, { version: VAULT_VERSION, updatedAt: new Date().toISOString(), patches: [] });
    const existingIndex = index.papers.findIndex((item) => item.id === record.id || item.arxivId === record.arxivId);
    if (existingIndex >= 0) index.papers = index.papers.map((item, position) => position === existingIndex ? record : item).filter((item, position, all) => all.findIndex((candidate) => candidate.id === item.id || candidate.arxivId === item.arxivId) === position);
    else index.papers = [record, ...index.papers];
    await this.writeIndex(index);
    return { ...paper, folder: record.folder };
  }

  async recordFor(paperId) {
    const index = await this.index();
    const record = index.papers.find((item) => item.id === paperId);
    if (!record) throw new Error('This paper is not yet in the local vault.');
    return record;
  }

  async sourceDirectory(paperId) {
    const record = await this.recordFor(paperId);
    return path.join(this.paperDirectory(record), 'attachments', 'source');
  }

  async saveSourceRecord(paperId, sourceRecord) {
    const record = await this.recordFor(paperId);
    const file = path.join(this.paperDirectory(record), 'paper.json');
    const paper = await readJson(file, {});
    await writeJson(file, { ...paper, source: { ...(paper.source ?? {}), ...sourceRecord }, updatedAt: new Date().toISOString() });
    return sourceRecord;
  }

  async removePaper(paperId) {
    const index = await this.index();
    const record = index.papers.find((item) => item.id === paperId);
    if (!record) throw new Error('This paper is not in the local vault.');
    const trashDirectory = path.join(this.root, '_trash');
    await mkdir(trashDirectory, { recursive: true });
    const archivedName = `${record.folder}--removed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(this.paperDirectory(record), path.join(trashDirectory, archivedName));
    index.papers = index.papers.filter((item) => item.id !== paperId);
    index.links = index.links.filter((link) => link.from.paperId !== paperId && link.to.paperId !== paperId);
    await this.writeIndex(index);
    for (const remaining of index.papers) {
      const incident = index.links.filter((link) => link.from.paperId === remaining.id || link.to.paperId === remaining.id);
      await writeJson(path.join(this.paperDirectory(remaining), 'links.json'), incident);
    }
    await this.rebuildGraph();
    return { paperId, archivedFolder: path.join('_trash', archivedName), recoverable: true };
  }

  async reorderPapers(paperIds) {
    const index = await this.index();
    const requested = Array.isArray(paperIds) ? paperIds.map(String) : [];
    const byId = new Map(index.papers.map((record) => [record.id, record]));
    const ordered = requested.map((id) => byId.get(id)).filter(Boolean);
    const seen = new Set(ordered.map((record) => record.id));
    index.papers = [...ordered, ...index.papers.filter((record) => !seen.has(record.id))];
    await this.writeIndex(index);
    return index.papers.map((record) => record.id);
  }

  async saveAudit(paper, audit) {
    const storedPaper = await this.upsertPaper(paper);
    const record = await this.recordFor(storedPaper.id);
    const directory = this.paperDirectory(record);
    await writeJson(path.join(directory, 'audit.json'), audit);
    await this.rebuildGraph();
    return storedPaper;
  }

  async saveReader(paperId, reader) {
    const record = await this.recordFor(paperId);
    const safeReader = {
      notes: Array.isArray(reader.notes) ? reader.notes : [],
      nodeNotes: reader.nodeNotes && typeof reader.nodeNotes === 'object' ? reader.nodeNotes : {},
      nodeAnswers: reader.nodeAnswers && typeof reader.nodeAnswers === 'object' ? reader.nodeAnswers : {},
      expanded: reader.expanded && typeof reader.expanded === 'object' ? reader.expanded : {},
      marks: reader.marks && typeof reader.marks === 'object' ? Object.fromEntries(Object.entries(reader.marks).filter(([, value]) => ['understood', 'question', 'error'].includes(value))) : {},
      updatedAt: new Date().toISOString(),
    };
    await writeJson(path.join(this.paperDirectory(record), 'reader.json'), safeReader);
    return safeReader;
  }

  async saveExport(paperId, exportRecord) {
    const record = await this.recordFor(paperId);
    const content = typeof exportRecord?.content === 'string' ? exportRecord.content : '';
    if (!content.trim()) throw new Error('The selected paper export is empty.');
    if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) throw new Error('The selected paper export is too large.');
    const requested = String(exportRecord?.fileName || 'reading-edition.md').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 120) || 'reading-edition.md';
    const fileName = requested.toLowerCase().endsWith('.md') ? requested : `${requested}.md`;
    const directory = path.join(this.paperDirectory(record), 'exports'); await mkdir(directory, { recursive: true });
    const file = path.join(directory, fileName); await writeFile(file, content, 'utf8');
    await writeJson(path.join(directory, `${fileName}.manifest.json`), { paperId, fileName, selection: exportRecord?.selection ?? {}, savedAt: new Date().toISOString() });
    return { fileName, relativePath: path.relative(this.root, file), bytes: Buffer.byteLength(content, 'utf8') };
  }

  async saveCitationAsset(paperId, upload) {
    const record = await this.recordFor(paperId);
    const encoded = typeof upload?.dataBase64 === 'string' ? upload.dataBase64 : '';
    const payload = Buffer.from(encoded, 'base64');
    if (!payload.length) throw new Error('The uploaded reference file is empty.');
    if (payload.length > 80 * 1024 * 1024) throw new Error('Reference uploads are limited to 80 MB.');
    const citation = upload?.citation && typeof upload.citation === 'object' ? upload.citation : {};
    const referenceName = slug(citation.key || citation.title || 'attached-reference', 72);
    const fileName = String(upload?.fileName || 'source.pdf').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 140) || 'source.pdf';
    const directory = path.join(this.paperDirectory(record), 'attachments', 'references', referenceName); await mkdir(directory, { recursive: true });
    const file = path.join(directory, fileName); await writeFile(file, payload);
    const manifestFile = path.join(directory, 'reference.json'); const previous = await readJson(manifestFile, { files: [] });
    const relativePath = path.relative(this.root, file);
    await writeJson(manifestFile, { citation: { key: String(citation.key || ''), title: String(citation.title || ''), authors: String(citation.authors || ''), locator: String(citation.locator || '') }, files: [...new Set([...(Array.isArray(previous.files) ? previous.files : []), relativePath])], updatedAt: new Date().toISOString() });
    return { fileName, relativePath, bytes: payload.length };
  }

  async savePatches(paperId, patches) {
    const record = await this.recordFor(paperId);
    const allowedKinds = new Set(['replace', 'delete', 'add']);
    const allowedNodeKinds = new Set(['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'proof', 'equation', 'remark', 'example', 'section', 'paragraph', 'figure', 'table', 'external-result']);
    const safePatches = Array.isArray(patches) ? patches.slice(0, 500).map((patch) => ({
      id: typeof patch.id === 'string' ? patch.id : randomUUID(),
      kind: allowedKinds.has(patch.kind) ? patch.kind : 'replace',
      nodeId: typeof patch.nodeId === 'string' ? patch.nodeId : '',
      title: typeof patch.title === 'string' ? patch.title : '',
      statement: typeof patch.statement === 'string' ? patch.statement : '',
      proofText: typeof patch.proofText === 'string' ? patch.proofText : '',
      nodeKind: allowedNodeKinds.has(patch.nodeKind) ? patch.nodeKind : '',
      afterNodeId: typeof patch.afterNodeId === 'string' ? patch.afterNodeId : '',
      rationale: typeof patch.rationale === 'string' ? patch.rationale : '',
      dependencies: Array.isArray(patch.dependencies) ? patch.dependencies.map(String).filter(Boolean).slice(0, 100) : [],
      proofSketch: Array.isArray(patch.proofSketch) ? patch.proofSketch.map(String).filter(Boolean).slice(0, 100) : [],
      source: patch.source === 'ai' ? 'ai' : 'manual',
      createdAt: typeof patch.createdAt === 'string' ? patch.createdAt : new Date().toISOString(),
    })).filter((patch) => patch.nodeId || (patch.kind === 'add' && patch.title && patch.statement)) : [];
    await writeJson(path.join(this.paperDirectory(record), 'editions', 'working', 'patches.json'), { version: VAULT_VERSION, updatedAt: new Date().toISOString(), patches: safePatches });
    await this.rebuildGraph();
    return safePatches;
  }

  async saveProfile(profile) {
    await this.ensure();
    const saved = { ...profile, updatedAt: new Date().toISOString() };
    await writeJson(this.profileFile, saved);
    return saved;
  }

  async allRecords() {
    const index = await this.index();
    const records = [];
    for (const record of index.papers) {
      const directory = this.paperDirectory(record);
      const [paper, audit, reader, patches] = await Promise.all([
        readJson(path.join(directory, 'paper.json'), null),
        readJson(path.join(directory, 'audit.json'), null),
        readJson(path.join(directory, 'reader.json'), { notes: [], nodeNotes: {}, nodeAnswers: {}, expanded: {}, marks: {} }),
        readJson(path.join(directory, 'editions', 'working', 'patches.json'), { patches: [] }),
      ]);
      if (paper) records.push({ paper, audit, reader, patches: Array.isArray(patches.patches) ? patches.patches : [], folder: record.folder });
    }
    return records;
  }

  async snapshot() {
    const [records, index, profile, graph] = await Promise.all([
      this.allRecords(), this.index(), readJson(this.profileFile, null), readJson(this.graphFile, { version: VAULT_VERSION, nodes: [], edges: [], updatedAt: null }),
    ]);
    const papers = records.map((record) => record.paper);
    const audits = Object.fromEntries(records.filter((record) => record.audit).map((record) => [record.paper.id, record.audit]));
    const notes = records.flatMap((record) => record.reader.notes ?? []);
    const nodeNotes = Object.fromEntries(records.map((record) => [record.paper.id, record.reader.nodeNotes ?? {}]));
    const nodeAnswers = Object.fromEntries(records.map((record) => [record.paper.id, record.reader.nodeAnswers ?? {}]));
    const expanded = Object.fromEntries(records.map((record) => [record.paper.id, record.reader.expanded ?? {}]));
    const marks = Object.fromEntries(records.map((record) => [record.paper.id, record.reader.marks ?? {}]));
    const patches = Object.fromEntries(records.map((record) => [record.paper.id, record.patches ?? []]));
    return { papers, audits, notes, nodeNotes, nodeAnswers, expanded, marks, patches, profile, links: index.links, graph, vault: { folder: this.root, paperFolders: records.map((record) => ({ paperId: record.paper.id, folder: record.folder })) } };
  }

  async compactInventory() {
    const records = await this.allRecords();
    return records.map((record) => ({
      paperId: record.paper.id,
      title: record.paper.title,
      arxivId: record.paper.arxivId,
      units: (record.audit?.nodes ?? []).filter((node) => ['definition', 'lemma', 'proposition', 'theorem', 'corollary', 'external-result'].includes(node.kind)).slice(0, 18).map((node) => ({ id: node.id, label: node.label, title: node.title, kind: node.kind })),
    }));
  }

  async addLink(link) {
    const index = await this.index();
    const from = link?.from; const to = link?.to;
    if (!from?.paperId || !from?.nodeId || !to?.paperId || !to?.nodeId) throw new Error('A source and target document unit are required.');
    if (from.paperId === to.paperId && from.nodeId === to.nodeId) throw new Error('A document unit cannot link to itself.');
    const existing = index.links.find((item) => item.from.paperId === from.paperId && item.from.nodeId === from.nodeId && item.to.paperId === to.paperId && item.to.nodeId === to.nodeId && item.relation === link.relation);
    if (existing) return existing;
    const relation = ['uses', 'extends', 'background', 'contrasts'].includes(link.relation) ? link.relation : 'uses';
    const created = { id: randomUUID(), from: { paperId: String(from.paperId), nodeId: String(from.nodeId) }, to: { paperId: String(to.paperId), nodeId: String(to.nodeId) }, relation, note: String(link.note || ''), source: 'manual', createdAt: new Date().toISOString() };
    index.links.push(created);
    await this.writeIndex(index);
    await this.writeIncidentLinks(created);
    await this.rebuildGraph();
    return created;
  }

  async removeLink(linkId) {
    const index = await this.index();
    const link = index.links.find((item) => item.id === linkId);
    if (!link) return;
    index.links = index.links.filter((item) => item.id !== linkId);
    await this.writeIndex(index);
    await this.writeIncidentLinks(link);
    await this.rebuildGraph();
  }

  async writeIncidentLinks(link) {
    const index = await this.index();
    for (const paperId of new Set([link.from.paperId, link.to.paperId])) {
      const record = index.papers.find((item) => item.id === paperId);
      if (!record) continue;
      const incident = index.links.filter((item) => item.from.paperId === paperId || item.to.paperId === paperId);
      await writeJson(path.join(this.paperDirectory(record), 'links.json'), incident);
    }
  }

  async rebuildGraph() {
    const [records, index] = await Promise.all([this.allRecords(), this.index()]);
    const nodes = [];
    const edges = [];
    const known = new Set();
    for (const record of records) {
      for (const node of workingNodes(record.audit?.nodes ?? [], record.patches ?? [])) {
        const id = `${record.paper.id}::${node.id}`;
        known.add(id);
        nodes.push({ id, paperId: record.paper.id, paperTitle: record.paper.title, arxivId: record.paper.arxivId, nodeId: node.id, label: node.label, title: node.title, kind: node.kind, page: node.anchor?.page ?? null, status: node.status });
      }
    }
    for (const record of records) {
      for (const node of workingNodes(record.audit?.nodes ?? [], record.patches ?? [])) {
        const from = `${record.paper.id}::${node.id}`;
        for (const dependency of node.dependencies ?? []) {
          const to = dependency.includes('::') ? dependency : `${record.paper.id}::${dependency}`;
          if (known.has(to)) edges.push({ id: `intra:${from}:${to}`, from, to, relation: 'uses', source: 'audit' });
        }
      }
      for (const link of record.audit?.crossPaperLinks ?? []) {
        const from = `${record.paper.id}::${link.fromNodeId}`;
        const to = `${link.targetPaperId}::${link.targetNodeId}`;
        if (known.has(from) && known.has(to)) edges.push({ id: `audit-cross:${from}:${to}:${link.relation}`, from, to, relation: link.relation, source: 'audit', note: String(link.rationale || '') });
      }
    }
    for (const link of index.links) {
      const from = `${link.from.paperId}::${link.from.nodeId}`;
      const to = `${link.to.paperId}::${link.to.nodeId}`;
      if (known.has(from) && known.has(to)) edges.push({ id: `manual:${link.id}`, from, to, relation: link.relation, source: 'manual', note: link.note || '' });
    }
    const graph = { version: VAULT_VERSION, updatedAt: new Date().toISOString(), nodes, edges };
    await writeJson(this.graphFile, graph);
    return graph;
  }
}

function workingNodes(nodes, patches) {
  const deleted = new Set(patches.filter((patch) => patch.kind === 'delete').map((patch) => patch.nodeId));
  const replacements = new Map(patches.filter((patch) => patch.kind === 'replace').map((patch) => [patch.nodeId, patch]));
  const result = [];
  for (const node of nodes) {
    if (deleted.has(node.id)) continue;
    const replacement = replacements.get(node.id);
    result.push(replacement ? { ...node, kind: replacement.nodeKind || node.kind, title: replacement.title || node.title, statement: replacement.statement || node.statement, proofText: replacement.proofText || node.proofText, dependencies: replacement.dependencies?.length ? replacement.dependencies : node.dependencies, proofSketch: replacement.proofSketch?.length ? replacement.proofSketch : node.proofSketch, status: 'needs-verification', anchor: { ...node.anchor, confidence: 'approximate' } } : node);
    for (const patch of patches.filter((item) => item.kind === 'add' && item.afterNodeId === node.id)) {
      result.push({ id: `working-${patch.id}`, kind: patch.nodeKind || 'proposition', label: 'Working edition', title: patch.title, statement: patch.statement, proofText: patch.proofText || '', status: 'needs-verification', anchor: { label: 'Working edition — reader addition', page: null, confidence: 'unverified' }, role: patch.rationale || 'Reader-added proposition', dependencies: patch.dependencies ?? [], proofSketch: patch.proofSketch ?? [], whyItMatters: 'This unit was added in the working edition and is not part of the original source.', expandable: true });
    }
  }
  return result;
}
