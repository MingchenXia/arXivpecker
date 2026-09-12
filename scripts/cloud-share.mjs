import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const providerDefinitions = [
  { id: 'icloud', label: 'iCloud Drive', connectUrl: 'https://www.icloud.com/iclouddrive/', candidates: [path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')] },
  { id: 'dropbox', label: 'Dropbox', connectUrl: 'https://www.dropbox.com/home', candidates: [path.join(os.homedir(), 'Dropbox'), path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox')] },
  { id: 'google-drive', label: 'Google Drive', connectUrl: 'https://drive.google.com/drive/my-drive', cloudPrefix: 'GoogleDrive-' },
  { id: 'onedrive', label: 'OneDrive', connectUrl: 'https://onedrive.live.com/', cloudPrefix: 'OneDrive-' },
];

function safeName(value, fallback = 'arxivpecker-share') {
  return String(value || fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || fallback;
}

async function exists(directory) {
  try { return (await lstat(directory)).isDirectory(); }
  catch { return false; }
}

async function cloudStorageMatches(prefix) {
  const root = path.join(os.homedir(), 'Library', 'CloudStorage');
  try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map((entry) => path.join(root, entry.name)); }
  catch { return []; }
}

async function providerDirectory(definition) {
  const qaOverride = process.env.ARXIVPECKER_CLOUD_TEST_DIR;
  if (qaOverride && definition.id === 'icloud') return qaOverride;
  const candidates = [...(definition.candidates || []), ...(definition.cloudPrefix ? await cloudStorageMatches(definition.cloudPrefix) : [])];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return '';
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(Buffer.concat(stdout).toString('utf8').trim()) : reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with ${code}.`)));
  });
}

async function gitAvailable() {
  try { await run('git', ['--version']); return true; }
  catch { return false; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function portableCopy(source, destination, depth = 0) {
  if (depth > 12) throw new Error('The selected source tree is too deeply nested to share safely.');
  const details = await lstat(source);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['proofroom-uploaded-source.json', '__MACOSX'].includes(entry.name)) continue;
      if (depth === 0 && entry.isDirectory() && entry.name === 'versions') continue;
      await portableCopy(path.join(source, entry.name), path.join(destination, entry.name), depth + 1);
    }
    return;
  }
  if (!details.isFile()) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function portablePaper(paper) {
  const source = paper?.source && typeof paper.source === 'object' ? paper.source : {};
  return {
    id: String(paper.id || ''), title: String(paper.title || ''), authors: String(paper.authors || ''), category: String(paper.category || ''), arxivId: String(paper.arxivId || ''), abstract: String(paper.abstract || ''), state: String(paper.state || 'To read'), tags: Array.isArray(paper.tags) ? paper.tags.map(String) : [],
    source: { analysisFormat: String(source.analysisFormat || ''), sourceFetchedAt: source.sourceFetchedAt || source.sourceUploadedAt || null, abstractUrl: source.abstractUrl || '', pdfUrl: source.pdfUrl || '', texUrl: source.texUrl || '' },
  };
}

function portableAudit(audit) {
  if (!audit || typeof audit !== 'object') return audit;
  // Codex thread identifiers are meaningful only on the originating machine
  // and can reveal a private local conversation reference. A recipient's first
  // Ask action will create and persist a fresh reader thread for their copy.
  return { ...audit, threadId: '' };
}

function normalizeSelection(selection) {
  const value = selection && typeof selection === 'object' ? selection : {};
  return { source: value.source !== false, audit: value.audit !== false, notes: value.notes !== false, edits: value.edits !== false, references: value.references !== false, preferences: value.preferences !== false };
}

async function buildShare(vault, request, destination) {
  const records = await vault.allRecords();
  const requested = new Set(Array.isArray(request.paperIds) ? request.paperIds.map(String) : []);
  const selected = records.filter((record) => requested.has(record.paper.id));
  if (!selected.length) throw new Error('Select at least one paper to share.');
  const selection = normalizeSelection(request.selection);
  const index = await vault.index();
  const snapshot = await vault.snapshot();
  await mkdir(destination, { recursive: true });
  const manifest = { version: 1, app: 'arXivpecker', shareId: randomUUID(), title: String(request.title || 'Shared reading library').trim().slice(0, 120), createdAt: new Date().toISOString(), paperIds: selected.map((record) => record.paper.id), selection };
  await writeJson(path.join(destination, 'share.json'), manifest);
  await writeFile(path.join(destination, 'README.md'), `# ${manifest.title}\n\nPortable arXivpecker reading library shared on ${manifest.createdAt}.\n\nIncludes ${selected.length} selected paper${selected.length === 1 ? '' : 's'} and the reader data chosen in share.json.\n`, 'utf8');
  for (const record of selected) {
    const paperDirectory = vault.paperDirectory({ folder: record.folder });
    const paperDestination = path.join(destination, 'papers', safeName(`${record.paper.arxivId}-${record.paper.title}`, record.paper.id));
    await mkdir(paperDestination, { recursive: true });
    await writeJson(path.join(paperDestination, 'paper.json'), portablePaper(record.paper));
    if (selection.audit && record.audit) await writeJson(path.join(paperDestination, 'audit.json'), portableAudit(record.audit));
    if (selection.notes) await writeJson(path.join(paperDestination, 'reader.json'), record.reader || { notes: [], nodeNotes: {}, nodeAnswers: {}, expanded: {}, marks: {} });
    if (selection.edits) await writeJson(path.join(paperDestination, 'working-edition.json'), { version: 1, patches: record.patches || [] });
    if (selection.source && await exists(path.join(paperDirectory, 'attachments', 'source'))) await portableCopy(path.join(paperDirectory, 'attachments', 'source'), path.join(paperDestination, 'source'));
    if (selection.references && await exists(path.join(paperDirectory, 'attachments', 'references'))) await portableCopy(path.join(paperDirectory, 'attachments', 'references'), path.join(paperDestination, 'references'));
  }
  const sharedLinks = (index.links || []).filter((link) => requested.has(link.from?.paperId) && requested.has(link.to?.paperId));
  if (sharedLinks.length) await writeJson(path.join(destination, 'links.json'), sharedLinks);
  if (selection.preferences) {
    await writeJson(path.join(destination, 'preferences', 'reading-profile.json'), snapshot.profile || null);
    await writeJson(path.join(destination, 'preferences', 'interface.json'), request.uiPreferences && typeof request.uiPreferences === 'object' ? request.uiPreferences : {});
  }
  return { manifest, paperCount: selected.length };
}

async function shareHistory(vault) {
  return readJson(path.join(vault.root, '_cloud', 'shares.json'), []);
}

async function rememberShare(vault, record) {
  if (process.env.ARXIVPECKER_DISABLE_SHARE_HISTORY === '1') return;
  const history = await shareHistory(vault);
  await writeJson(path.join(vault.root, '_cloud', 'shares.json'), [record, ...history].slice(0, 20));
}

function validateGitRemote(remote) {
  const value = String(remote || '').trim();
  if (!value) throw new Error('Enter a Git remote repository.');
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('Do not put passwords or tokens in the Git URL. Use your system Git credential manager.');
    return value;
  }
  if (/^(?:ssh:\/\/|git@)[^\s]+/i.test(value) || path.isAbsolute(value)) return value;
  throw new Error('Use an HTTPS, SSH, git@host:path, or absolute local Git repository URL.');
}

async function remoteHasBranch(repository, branch) {
  try { await run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repository }); return true; }
  catch { return false; }
}

async function publishGit(vault, request, stagedShare, shareName, summary) {
  const remote = validateGitRemote(request.gitRemote);
  const branch = String(request.gitBranch || 'main').trim();
  await run('git', ['check-ref-format', '--branch', branch]);
  const key = createHash('sha256').update(remote).digest('hex').slice(0, 16);
  const repository = path.join(process.env.ARXIVPECKER_GIT_CACHE_ROOT || path.join(vault.root, '_cloud', 'git'), key);
  if (!await exists(path.join(repository, '.git'))) {
    await mkdir(path.dirname(repository), { recursive: true });
    await run('git', ['clone', remote, repository]);
  } else {
    await run('git', ['remote', 'set-url', 'origin', remote], { cwd: repository });
    await run('git', ['fetch', 'origin'], { cwd: repository });
  }
  if (await remoteHasBranch(repository, branch)) {
    await run('git', ['checkout', '-B', branch, `origin/${branch}`], { cwd: repository });
    await run('git', ['pull', '--rebase', 'origin', branch], { cwd: repository });
  } else {
    try { await run('git', ['checkout', branch], { cwd: repository }); }
    catch { await run('git', ['checkout', '-b', branch], { cwd: repository }); }
  }
  const destination = path.join(repository, 'shares', shareName);
  await portableCopy(stagedShare, destination);
  await writeJson(path.join(repository, 'latest.json'), { share: path.join('shares', shareName), updatedAt: new Date().toISOString(), paperCount: summary.paperCount });
  await run('git', ['add', 'shares', 'latest.json'], { cwd: repository });
  const changed = await run('git', ['status', '--porcelain'], { cwd: repository });
  if (changed) {
    await run('git', ['config', 'user.name', 'arXivpecker'], { cwd: repository });
    await run('git', ['config', 'user.email', 'arxivpecker@local'], { cwd: repository });
    await run('git', ['commit', '-m', `Share ${summary.manifest.title}`], { cwd: repository });
  }
  await run('git', ['push', '-u', 'origin', branch], { cwd: repository });
  return { provider: 'git', providerLabel: 'Git', fileName: shareName, location: `${remote} · ${branch} · shares/${shareName}`, connectUrl: '', paperCount: summary.paperCount };
}

export async function cloudStatus(vault) {
  const drives = [];
  for (const definition of providerDefinitions) {
    const directory = await providerDirectory(definition);
    drives.push({ id: definition.id, label: definition.label, available: Boolean(directory), connectUrl: definition.connectUrl, detail: directory ? 'Connected on this Mac' : 'Sign in with the desktop sync app' });
  }
  drives.push({ id: 'git', label: 'Git', available: await gitAvailable(), connectUrl: 'https://github.com/login', detail: 'Uses SSH or the system Git credential manager' });
  return { providers: drives, recent: await shareHistory(vault) };
}

export async function createCloudShare(vault, request) {
  const provider = String(request.provider || 'icloud');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-share-'));
  const shareName = `${safeName(request.title, 'reading-library')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}`;
  const stagedShare = path.join(temporary, shareName);
  try {
    const summary = await buildShare(vault, request, stagedShare);
    let result;
    if (provider === 'git') result = await publishGit(vault, request, stagedShare, shareName, summary);
    else {
      const definition = providerDefinitions.find((item) => item.id === provider);
      if (!definition) throw new Error('Choose a supported cloud provider.');
      const root = await providerDirectory(definition);
      if (!root) throw new Error(`${definition.label} is not connected on this Mac. Sign in with its desktop sync app, then refresh.`);
      const sharesDirectory = path.join(root, 'arXivpecker', 'Shares');
      await mkdir(sharesDirectory, { recursive: true });
      const archive = path.join(sharesDirectory, `${shareName}.zip`);
      await run('ditto', ['-c', '-k', '--norsrc', '--keepParent', stagedShare, archive]);
      result = { provider, providerLabel: definition.label, fileName: path.basename(archive), location: `${definition.label} / arXivpecker / Shares / ${path.basename(archive)}`, connectUrl: definition.connectUrl, paperCount: summary.paperCount };
    }
    const record = { ...result, id: summary.manifest.shareId, title: summary.manifest.title, createdAt: summary.manifest.createdAt };
    await rememberShare(vault, record);
    return record;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
