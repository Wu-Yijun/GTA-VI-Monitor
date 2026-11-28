#!/usr/bin/env node
/**
 * scripts/gta6-anomaly-refresh.mjs
 *
 * One-off refresh / extension for the published list.
 *
 * It runs after the normal sync (so dist/archives already holds every current
 * copy) and adds the repositories that the portwatch tracker does not list yet:
 * each one is cloned straight from GitHub on its own branch and appended as a
 * candidate row without a completion score.
 *
 * Every copy is written into the same per-repo Actions cache entry the sync
 * uses, and dist/runners.json + dist/index.html are regenerated.
 *
 * Nothing is written into the repository itself: the copies live in the
 * per-repo caches and in the Pages artifact only.
 *
 * Sources (the three repositories linked from GTA.html that portwatch does not
 * track yet; each is cloned from GitHub on its own branch and added as a
 * candidate row, without a completion score):
 *   JoshuuDev/victory-amd      (branch: victory-amd)
 *   CuteBooty/victory-8gb      (default branch)
 *   XaviFortes/VIctory-RDNA    (default branch)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ARCHIVES_DIR,
  CACHE_KEY_PREFIX,
  DIST_DIR,
  GOOD_ROOT,
  SITE_URL,
  assignNames,
  countCodeLinesInDir,
  generatePages,
  makeArchive,
  makeCacheTools,
} from './gta6-windows-runner-sync.mjs';

const ROOT = process.cwd();
const CACHE_ROOT = path.join(ROOT, '.cache');
const TMP_ROOT = path.join(CACHE_ROOT, 'tmp');
const SWH_BASE = 'https://archive.softwareheritage.org/api/1';

const SOURCES = [
  {
    repo: 'JoshuuDev/victory-amd',
    kind: 'git',
    ref: 'victory-amd',
    extra: true,
    description: 'AMD fork; stutter frames (>1 s) fell from 42% to 14% on an RX 7800 XT, the first prologue room shows walls, dark areas may still lack light.',
  },
  {
    repo: 'CuteBooty/victory-8gb',
    kind: 'git',
    extra: true,
    description: '8 GB NVIDIA build; a 104-minute run completed the first chapter mission on an RTX 3070 with 32 GB RAM, Series S 1080p preset.',
  },
  {
    repo: 'XaviFortes/VIctory-RDNA',
    kind: 'git',
    extra: true,
    description: 'RDNA build; RX 7900 XT 20 GB measured a 23.1 fps median at 4K (heavy scenes 19.1 fps), ray tracing and frame generation off.',
  },
];

const SKIPPED = [];

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 900000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  }
  return result.stdout || '';
}

function unzip(zipPath, destination) {
  rmrf(destination);
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destination], { encoding: 'utf8', timeout: 300000 });
  if (result.status !== 0) throw new Error(`unzip failed: ${(result.stderr || '').slice(0, 200)}`);
}

async function fetchWithRetry(url, options = {}, attempts = 3, timeout = 60000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
      if (response.ok) return response;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return response;
    } catch {
      /* retry */
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  return null;
}

// ---------------- Software Heritage incremental merge ----------------

let swhRequests = 0;
let swhLast = 0;

async function swhFetch(url) {
  if (swhRequests >= 70) throw new Error('SWH request budget exhausted');
  const wait = 800 - (Date.now() - swhLast);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  swhLast = Date.now();
  swhRequests += 1;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': 'gta6-anomaly-refresh' } }, 3, 90000);
  if (!response || !response.ok) throw new Error(`SWH request failed: ${response ? response.status : 'network'}`);
  return response;
}

async function swhJson(url) {
  return (await swhFetch(url)).json();
}

async function swhRaw(url) {
  return Buffer.from(await (await swhFetch(url)).arrayBuffer());
}

function gitBlobHash(file) {
  const data = fs.readFileSync(file);
  return crypto.createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
}

async function swhCollect(dirId, rel, files, skipTop) {
  const entries = await swhJson(`${SWH_BASE}/directory/${dirId}/`);
  for (const entry of entries) {
    const pathName = rel ? `${rel}/${entry.name}` : entry.name;
    if (!rel && skipTop.includes(entry.name)) continue;
    if (entry.type === 'dir') await swhCollect(entry.target, pathName, files, skipTop);
    else if (entry.type === 'file') files.push({ path: pathName, target: entry.target });
  }
}

async function swhMerge(source, goodDir) {
  const files = [];
  await swhCollect(source.root, '', files, source.skipTop || []);
  let added = 0;
  let changed = 0;
  for (const file of files) {
    const local = path.join(goodDir, file.path);
    if (fs.existsSync(local) && gitBlobHash(local) === file.target) continue;
    if (fs.existsSync(local)) changed += 1;
    else added += 1;
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, await swhRaw(`${SWH_BASE}/content/sha1_git:${file.target}/raw/`));
  }
  let date = null;
  try {
    date = (await swhJson(`${SWH_BASE}/revision/${source.revision}/`)).date || null;
  } catch {
    /* metadata is optional */
  }
  return { added, changed, date, requests: swhRequests, files: files.length };
}

// ---------------- source materialization ----------------

async function downloadSiteArchive(name, prev) {
  const file = (prev && prev.archive) || `${name}.zip`;
  const response = await fetchWithRetry(`${SITE_URL}archives/${encodeURIComponent(file)}`, {}, 2, 90000);
  if (!response || !response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return null;
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const out = path.join(TMP_ROOT, `${name}.zip`);
  fs.writeFileSync(out, buffer);
  return out;
}

async function materialize(source, name, prev, tools) {
  const goodDir = path.join(GOOD_ROOT, name);
  const prefix = `${CACHE_KEY_PREFIX}${name}-`;
  rmrf(goodDir);
  fs.mkdirSync(goodDir, { recursive: true });

  if (source.kind === 'git') {
    const url = `https://github.com/${source.from || source.repo}`;
    const branchArgs = source.ref ? ['--branch', source.ref] : [];
    git(['clone', '--quiet', '--depth', '1', ...branchArgs, url, goodDir], ROOT);
    const sha = git(['rev-parse', 'HEAD'], goodDir).trim();
    const ref = git(['rev-parse', '--abbrev-ref', 'HEAD'], goodDir).trim();
    return { goodDir, cacheSha: sha, branch: ref, sourceOnly: false, detail: { kind: 'git', repo: source.from || source.repo, ref, sha } };
  }

  if (source.kind === 'git-subdir') {
    const url = `https://github.com/${source.from}`;
    const branchArgs = source.ref ? ['--branch', source.ref] : [];
    const tmp = path.join(TMP_ROOT, name);
    rmrf(tmp);
    git(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', ...branchArgs, url, tmp], ROOT);
    git(['sparse-checkout', 'set', source.subdir], tmp);
    rmrf(goodDir);
    fs.cpSync(path.join(tmp, source.subdir), goodDir, { recursive: true });
    const sha = git(['rev-parse', 'HEAD'], tmp).trim();
    const ref = git(['rev-parse', '--abbrev-ref', 'HEAD'], tmp).trim();
    rmrf(tmp);
    return {
      goodDir,
      cacheSha: sha,
      branch: ref,
      sourceOnly: true,
      detail: { kind: 'git-subdir', repo: source.from, ref, subdir: source.subdir, sha },
    };
  }

  if (source.kind === 'swh') {
    const restored = await tools.restore(goodDir, `${prefix}${(prev && prev.cacheSha) || 'last'}`, prefix);
    if (!restored) {
      const zip = await downloadSiteArchive(name, prev);
      if (!zip) throw new Error('no base copy: cache miss and the deployed archive is unavailable');
      unzip(zip, goodDir);
      console.log(`  ~ ${source.repo}: base copy taken from the deployed archive`);
    }
    const result = await swhMerge(source, goodDir);
    return {
      goodDir,
      cacheSha: source.revision,
      sourceOnly: !fs.existsSync(path.join(goodDir, '.git')),
      detail: { kind: 'swh', revision: source.revision, date: result.date, added: result.added, changed: result.changed, requests: result.requests },
    };
  }

  throw new Error(`unknown source kind: ${source.kind}`);
}

// ---------------- state ----------------

async function readState() {
  const local = path.join(DIST_DIR, 'runners.json');
  if (fs.existsSync(local)) {
    return JSON.parse(fs.readFileSync(local, 'utf8'));
  }
  const response = await fetchWithRetry(`${SITE_URL}runners.json`, {}, 3, 30000);
  if (!response || !response.ok) throw new Error('cannot read runners.json (local and deployed)');
  return response.json();
}

async function main() {
  fs.mkdirSync(GOOD_ROOT, { recursive: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });

  const state = await readState();
  const records = new Map();
  for (const record of state.repos || []) {
    if (!record) continue;
    const key = record.repo || (record.id ? `private:${record.id}` : null);
    if (key) records.set(key, record);
  }

  const tools = makeCacheTools();
  if (!tools.enabled) throw new Error('cache service is not available (run through the workflow)');

  const names = assignNames(SOURCES.map((source) => ({ repo: source.repo })));
  let applied = 0;

  for (const source of SOURCES) {
    const name = names.get(source.repo);
    const prev = records.get(source.repo) || null;
    const privateKey = source.id ? `private:${source.id}` : null;
    const priv = privateKey ? records.get(privateKey) || null : null;
    try {
      const result = await materialize(source, name, prev, tools);
      const counted = countCodeLinesInDir(result.goodDir);
      const archive = makeArchive(result.goodDir, name);
      if (!archive) throw new Error('archive generation failed');
      const saved = await tools.save(result.goodDir, `${CACHE_KEY_PREFIX}${name}-${result.cacheSha}`);

      if (source.extra) {
        const record = {
          repo: source.repo,
          source: source.source || 'candidate',
          id: source.id || null,
          name: (prev && prev.name) || (priv && priv.name) || null,
          branch: result.branch || source.ref || 'main',
          headSha: result.cacheSha,
          cacheSha: result.cacheSha,
          status: 'accessible',
          files: counted.files,
          codeLines: counted.lines,
          archiveLines: counted.lines,
          observation: null,
          anomalies: [],
          error: false,
          archive,
          description: source.description || (prev && prev.description) || (priv && priv.description) || source.repo,
          completion:
            prev && prev.completion != null
              ? prev.completion
              : priv && priv.completion != null
                ? priv.completion
                : null,
          archived: false,
          sourceOnly: result.sourceOnly,
          mirror: source.mirror || null,
          delisted: false,
          extra: true,
        };
        records.set(source.repo, record);
        if (privateKey && records.delete(privateKey)) console.log(`  - dropped the old private row (${privateKey})`);
        applied += 1;

        console.log(
          `ADD  ${source.repo} branch=${record.branch} files=${counted.files} lines=${counted.lines} cache=${saved ? 'saved' : 'FAILED'} zip=${archive}`,
        );
        continue;
      }

      const record = prev || {
        repo: source.repo,
        source: 'effort',
        id: null,
        branch: 'main',
        status: 'inaccessible',
        anomalies: [],
        error: true,
        description: source.repo,
        completion: null,
        archived: false,
      };
      record.status = 'inaccessible';
      record.branch = source.ref || record.branch || 'main';
      record.anomalies = Array.from(new Set([...(record.anomalies || []), 'disappeared', 'mirrored']));
      record.error = true;
      record.files = counted.files;
      record.codeLines = counted.lines;
      record.archiveLines = counted.lines;
      record.observation = null;
      record.cacheSha = result.cacheSha;
      record.headSha = null;
      record.archive = archive;
      record.sourceOnly = result.sourceOnly;
      record.mirror = { ...result.detail, note: source.note, refreshedAt: new Date().toISOString() };
      records.set(source.repo, record);
      applied += 1;

      console.log(
        `OK   ${source.repo} <- ${source.from || `swh:${source.revision.slice(0, 12)}`} files=${counted.files} lines=${counted.lines} cache=${saved ? 'saved' : 'FAILED'} zip=${archive}`,
      );
    } catch (error) {
      console.error(`FAIL ${source.repo}: ${error.message}`);
    }
  }

  for (const skipped of SKIPPED) {
    console.log(`SKIP ${skipped.repo}: ${skipped.reason}`);
  }

  generatePages(Array.from(records.values()));
  console.log(`\nDone: ${applied}/${SOURCES.length} sources applied; dist/runners.json + dist/index.html regenerated`);
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
