#!/usr/bin/env node
/**
 * scripts/gta6-anomaly-refresh.mjs
 *
 * One-off refresh / extension for the published list.
 *
 * It runs after the normal sync (so dist/archives already holds every current
 * copy) and then:
 *   1. restores repositories that disappeared from GitHub from a known mirror;
 *   2. adds repositories that the portwatch tracker does not list (the i95
 *      ranking), cloned straight from GitHub;
 *   3. replaces the old private-only darkworldhm row with its public
 *      darkworldhm/victory-fork-darkworldhm repository, which exists on GitHub
 *      (its current HEAD matches the copy i95 vendors).
 *
 * Every copy is written into the same per-repo Actions cache entry the sync
 * uses, and dist/runners.json + dist/index.html are regenerated.
 *
 * Nothing is written into the repository itself: the copies live in the
 * per-repo caches and in the Pages artifact only.
 *
 * Sources:
 *   realdody/americas-recomp -> Frollir/americas-recomp (xbox-series branch)
 *   14 i95 repositories not tracked by portwatch (cloned from GitHub, added
 *      as candidate rows)
 *   darkworldhm/victory-fork-darkworldhm -> cloned from GitHub like the rest,
 *      added as the public effort row (replaces the private-only row)
 *   zohaiblazuli/GrandTheftXbox -> no public mirror found (skipped)
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
    repo: 'realdody/americas-recomp',
    kind: 'git',
    from: 'Frollir/americas-recomp',
    ref: 'xbox-series',
    note: 'preserved fork of the deleted repo; its main was an empty initial commit, the code is on xbox-series',
  },

  // i95-ranked repositories (https://github.com/DesignWithTommy/i95) that the
  // portwatch tracker does not list. They are normal public GitHub
  // repositories, cloned on their default branch and added as candidate rows;
  // no completion score exists because the tracker has no effort for them.
  {
    repo: 'fablinoo/kelvaroq',
    kind: 'git',
    extra: true,
    description: '~10 fps in typical views on an RTX 5080; a tester ran 36 min without a crash.',
  },
  {
    repo: 'PastiiJay/klbf-lab',
    kind: 'git',
    extra: true,
    description: 'Playable through the prologue at ~5.7-7.3 fps; 77 min session on an RX 9070 XT.',
  },
  {
    repo: 'realblastex/flamingo',
    kind: 'git',
    extra: true,
    description: 'Tuned on an RTX 4070; 9-12 fps in the first scene, 24 min session.',
  },
  {
    repo: 'TaynanGT/Vice-Tay',
    kind: 'git',
    extra: true,
    description: '30 min in the world without a crash, 7.0 fps median on an RTX 4090.',
  },
  {
    repo: 'edsuuu/VI-BR-PORT',
    kind: 'git',
    extra: true,
    description: '8 GB build: 4-7 fps at 1080p, hour-long sessions on an RTX 4060 Ti.',
  },
  {
    repo: 'proneonn/Vertex',
    kind: 'git',
    extra: true,
    description: 'Not playable yet; ~7-10 fps, no crash in 16 of 18 sessions on an RTX 5070.',
  },
  {
    repo: 'LoverCatys/ruff-lab',
    kind: 'git',
    extra: true,
    description: 'Built for 8 GB cards and 16 GB RAM; 3.6 fps average, 39 min on an RX 6600 XT.',
  },
  {
    repo: 'Itsbatt/victory-unified',
    kind: 'git',
    extra: true,
    description: 'Unified fork; ~58 min without a crash at 2-3 fps on an RTX 3070 8 GB.',
  },
  {
    repo: 'cocainebunnylaboratories/cblvictoryvi',
    kind: 'git',
    extra: true,
    description: '3.63-6.39 fps by scene at 4K, 27 min run on an RTX 5080.',
  },
  {
    repo: 'KomanderDG88/VIniVIdiVIci',
    kind: 'git',
    extra: true,
    description: 'About 3-5 fps on an RTX 4060 Ti, 46 min session.',
  },
  {
    repo: 'voidopcode/vilocity',
    kind: 'git',
    extra: true,
    description: 'Not playable yet; ~11 fps on the Series S profile, RTX 5080; runs end ~7 min in.',
  },
  {
    repo: 'ka1qux/BRVIctory-ka1qux',
    kind: 'git',
    extra: true,
    description: 'Measured on AMD: 3.2-3.6 fps, 25 min session on an RX 7800 XT.',
  },
  {
    repo: 'myokex/victory-amd',
    kind: 'git',
    extra: true,
    description: 'First room at 2-3 fps, runs of about 8 min on an RX 7800 XT.',
  },
  {
    repo: 'ZigZagBoi1/ScarlettPort',
    kind: 'git',
    extra: true,
    description: 'About 4 fps in the opening mission on an RTX 3060.',
  },

  // darkworldhm has a public repository after all; its HEAD matches the copy
  // i95 vendors, so it is cloned directly. `id` lets the one-off run drop the
  // old private-only row and lets the regular sync keep suppressing it.
  {
    repo: 'darkworldhm/victory-fork-darkworldhm',
    kind: 'git',
    extra: true,
    source: 'effort',
    id: 'darkworldhm',
    description: 'A snapshot of victory-fork with its own changes; the stream build showed 5 to 24 fps (unconfirmed).',
  },
];

const SKIPPED = [
  { repo: 'zohaiblazuli/GrandTheftXbox', reason: 'no public mirror found (repo and its only fork are gone, SWH only has not_found visits)' },
];

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
