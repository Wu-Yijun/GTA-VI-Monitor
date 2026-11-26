#!/usr/bin/env node
/**
 * scripts/gta6-windows-runner-sync.mjs
 *
 * Run on the Linux runner by .github/workflows/gta6-windows-runners.yml.
 *
 * Storage model
 * -------------
 * Every repository has its own GitHub Actions cache entry, driven from this
 * script with @actions/cache (installed at runtime by the workflow):
 *
 *   key  = gta6-repo-v1-<owner>__<name>-<cacheSha>
 *   path = .cache/good/<owner>__<name>
 *
 * `.cache/good/<name>` always holds the last ACCEPTED copy ("good copy").
 * Cache entries are immutable, so a new entry is written only when a new copy
 * is accepted; superseded entries are left to GitHub's LRU eviction (they are
 * never restored again, so they are the first to go when the 10 GB limit is
 * reached).
 *
 * The previous run's index/baselines/observation progress are read back from
 * the deployed https://wu-yijun.github.io/GTA-VI-Monitor/runners.json.
 * Fallbacks:
 *   - cache entry missing  -> the copy is taken from the deployed
 *                             archives/<name>.zip (same tree, no .git);
 *   - site state missing   -> baselines are re-counted from the good copies
 *                             (only the observation streak is lost);
 *   - both missing         -> an accessible repository is re-cloned
 *                             (no shrink detection possible for that run).
 *
 * Effective code lines
 * --------------------
 * Only non-blank lines of whitelisted source extensions are counted; whole-line
 * comments are excluded with a small per-language lexer. Vendored/generated
 * code is excluded. The counting method is versioned (METRIC_VERSION): when it
 * changes, stale baselines are ignored and re-counted.
 *
 * Shrink / freeze policy
 * ----------------------
 *   freeze  : cur < 40% of baseline (the last accepted copy)
 *   dead    : cur < 5% of baseline; only disables the 3-growth recovery
 *   recover : cur >= baseline
 *             || cur >= 1.2 * prev && cur - prev >= 200
 *             || cur - prev >= 500
 *             || !dead && growth >= 3
 *   growth  : +1 when cur > prev; reset when cur < 0.8 * prev; unchanged when
 *             flat or within a -20% move.
 * While frozen the old copy is served and nothing is overwritten.
 *
 * Page
 * ----
 * dist/index.html + dist/runners.json, three added columns:
 * current effective lines, archived (good copy) effective lines, observation
 * progress n/3 (or 不可恢复).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// ---------------- configuration ----------------

const ROOT = process.cwd();
const TRACKER_URL = 'https://portwatch-vi.xyz/data/tracker.json';
const SITE_URL = 'https://wu-yijun.github.io/GTA-VI-Monitor/';
const CACHE_ROOT = path.join(ROOT, '.cache');
const GOOD_ROOT = path.join(CACHE_ROOT, 'good');
const WORK_ROOT = path.join(CACHE_ROOT, 'work');
const TMP_ROOT = path.join(CACHE_ROOT, 'tmp');
const DIST_DIR = path.join(ROOT, 'dist');
const ARCHIVES_DIR = path.join(DIST_DIR, 'archives');
const RUNNERS_JSON = path.join(DIST_DIR, 'runners.json');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

const CACHE_KEY_PREFIX = 'gta6-repo-v1-';
const METRIC_VERSION = 2;
const FREEZE_RATIO = 0.4;
const DEAD_RATIO = 0.05;
const JUMP_RATIO = 1.2;
const JUMP_MIN_LINES = 200;
const JUMP_ABS_LINES = 500;
const GROWTH_TARGET = 3;
const GROWTH_RESET_RATIO = 0.8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const ANOMALY_LABELS = {
  code_deleted: '代码大量删除',
  disappeared: '消失',
  frozen: '冻结',
  unrecoverable: '不可恢复',
};
const MENTION = /windows|native|wine|translation|compat|runtime|layer|emulator|shim|hook|x64|rust/i;

// ---------------- small helpers ----------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// ---------------- cache toolkit (installed at runtime by the workflow) ----------------

function makeCacheTools() {
  const depsDir = process.env.GTA6_CACHE_DEPS || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gta6-deps');
  const requireFromDeps = createRequire(path.join(depsDir, 'package.json'));

  let cache = null;
  try {
    cache = requireFromDeps('@actions/cache');
  } catch (error) {
    if (process.env.GTA6_REQUIRE_CACHE === '1') {
      console.error(`FATAL: @actions/cache could not be loaded from ${depsDir}: ${error.message}`);
      process.exit(1);
    }
    console.warn(`WARN: @actions/cache unavailable (${depsDir}); running without cache.`);
  }

  const serviceEnv = Boolean(
    process.env.ACTIONS_RUNTIME_TOKEN && (process.env.ACTIONS_CACHE_URL || process.env.ACTIONS_RESULTS_URL),
  );
  if (cache && !serviceEnv) {
    if (process.env.GTA6_REQUIRE_CACHE === '1') {
      console.error('FATAL: ACTIONS_RUNTIME_TOKEN / ACTIONS_CACHE_URL are missing; cannot use the cache service.');
      process.exit(1);
    }
    console.warn('WARN: cache service environment missing; running without cache.');
    cache = null;
  }

  return {
    enabled: Boolean(cache),
    async restore(dir, primaryKey, prefix) {
      if (!cache) return null;
      try {
        return (await cache.restoreCache([dir], primaryKey, [prefix])) ?? null;
      } catch (error) {
        console.warn(`  ! cache restore failed (${path.basename(dir)}): ${error.message}`);
        return null;
      }
    },
    async save(dir, key) {
      if (!cache) return false;
      if (!isDir(dir)) return false;
      try {
        await cache.saveCache([dir], key);
        return true;
      } catch (error) {
        // "cache already exists" on a rerun is benign.
        console.warn(`  ! cache save failed (${key}): ${error.message}`);
        return false;
      }
    },
  };
}

// ---------------- network helpers ----------------

async function fetchWithRetry(url, options = {}, attempts = 3, timeout = 20000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
      if (response.ok) return response;
      // 4xx (except rate limiting) is a definitive answer, do not retry.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return response;
    } catch {
      /* retry */
    }
    if (attempt < attempts - 1) await sleep(1500 * (attempt + 1));
  }
  return null;
}

// ---------------- git helpers ----------------

async function lsRemote(repoPath, attempts = 3) {
  const url = `https://github.com/${repoPath}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = spawnSync('git', ['ls-remote', '--symref', url, 'HEAD'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) {
      const out = r.stdout || '';
      const sha = out.match(/^([0-9a-f]{40})\s+HEAD/m);
      if (sha) {
        const branch = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
        return { sha: sha[1], branch: branch ? branch[1] : null };
      }
    }
    if (attempt < attempts - 1) await sleep(2000 * (attempt + 1));
  }
  return null;
}

async function cloneRepo(repoPath, branch, dir, attempts = 2) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    rmrf(dir);
    const r = spawnSync(
      'git',
      ['clone', '--quiet', '--depth', '1', '--branch', branch || 'main', `https://github.com/${repoPath}`, dir],
      { encoding: 'utf8', timeout: 300000 },
    );
    if (r.status === 0) return true;
    if (attempt < attempts - 1) await sleep(3000);
  }
  rmrf(dir);
  return false;
}

// ---------------- effective code line counting ----------------

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'inl', 'ipp',
  'rs', 'cs', 'java', 'kt', 'kts', 'scala', 'dart', 'php', 'groovy',
  'swift', 'm', 'mm', 'go', 'py', 'pyi', 'rb', 'lua',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'pl', 'pm', 'r', 'jl', 'nim',
  'hlsl', 'hlsli', 'glsl', 'vert', 'frag', 'comp', 'geom', 'tesc', 'tese', 'cg', 'metal', 'sl', 'slang',
  'zig', 'd', 'v', 'sv', 'svh', 'fs', 'fsx', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hrl', 'hs', 'ml', 'mli',
  'asm', 's', 'nasm', 'f', 'f90', 'f95', 'pas', 'vhd', 'dart', 'tcl', 'awk',
]);

const EXCLUDE_DIR_RE =
  /(^|\/)(node_modules|vendor|third[_-]?party|external|deps|bower_components|jspm_packages|dist|target|obj|coverage|generated|gen|__generated__)(\/|$)/i;
const EXCLUDE_FILE_RE =
  /(\.min\.(js|css)$|\.map$|\.lock$|\.snap$|_pb2\.py$|\.pb\.(go|cc|h|js)$|\.designer\.cs$|\.g\.(cs|i\.cs)$|\.generated\.\w+$|_generated\.\w+$)/i;

const COMMENT_STYLES = {
  slash: { line: ['//'], block: ['/*', '*/'] },
  hash: { line: ['#'] },
  dash: { line: ['--'] },
  semi: { line: [';'] },
  bang: { line: ['!'] },
  percent: { line: ['%'] },
  html: { block: ['<!--', '-->'] },
};

const EXT_STYLE = {
  c: 'slash', h: 'slash', cc: 'slash', cpp: 'slash', cxx: 'slash', hpp: 'slash', hh: 'slash', hxx: 'slash',
  inl: 'slash', ipp: 'slash', m: 'slash', mm: 'slash', rs: 'slash', cs: 'slash', java: 'slash', kt: 'slash',
  kts: 'slash', scala: 'slash', dart: 'slash', php: 'slash', groovy: 'slash', js: 'slash', jsx: 'slash',
  mjs: 'slash', cjs: 'slash', ts: 'slash', tsx: 'slash', mts: 'slash', cts: 'slash', go: 'slash',
  swift: 'slash', glsl: 'slash', hlsl: 'slash', hlsli: 'slash', vert: 'slash', frag: 'slash', comp: 'slash',
  geom: 'slash', tesc: 'slash', tese: 'slash', cg: 'slash', metal: 'slash', sl: 'slash', slang: 'slash',
  zig: 'slash', d: 'slash', v: 'slash', sv: 'slash', svh: 'slash', fs: 'slash', fsx: 'slash',
  py: 'hash', pyi: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', ps1: 'hash', psm1: 'hash',
  pl: 'hash', pm: 'hash', r: 'hash', jl: 'hash', nim: 'hash',
  lua: 'dash', sql: 'dash', hs: 'dash', vhd: 'dash',
  asm: 'semi', s: 'semi', nasm: 'semi', clj: 'semi', cljs: 'semi',
  f: 'bang', f90: 'bang', f95: 'bang',
  erl: 'percent', hrl: 'percent',
  html: 'html', xml: 'html',
};

function commentStyleFor(relPath) {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return COMMENT_STYLES[EXT_STYLE[ext] || 'slash'];
}

function isCodeFile(relPath) {
  if (EXCLUDE_DIR_RE.test(relPath) || EXCLUDE_FILE_RE.test(relPath)) return false;
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/** Count non-blank lines that are not whole-line comments. Inline comments count as code. */
function countCodeLines(text, style) {
  const lineMarks = style.line || [];
  const blockOpen = style.block ? style.block[0] : null;
  const blockClose = style.block ? style.block[1] : null;
  let inBlock = false;
  let count = 0;

  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    if (inBlock) {
      const end = line.indexOf(blockClose);
      if (end === -1) continue;
      line = line.slice(end + blockClose.length).trim();
      inBlock = false;
      if (!line) continue;
    }

    // Strip leading full-line comments.
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const mark of lineMarks) {
        if (line.startsWith(mark)) {
          line = line.slice(mark.length).trim();
          stripped = true;
          break;
        }
      }
    }
    if (!line) continue;

    // A block comment at the start of the line.
    if (blockOpen && line.startsWith(blockOpen)) {
      const end = line.indexOf(blockClose, blockOpen.length);
      if (end === -1) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + blockClose.length).trim();
      if (!line) continue;
    }

    count += 1;
    if (blockOpen) {
      const start = line.indexOf(blockOpen);
      if (start !== -1 && line.indexOf(blockClose, start + blockOpen.length) === -1) inBlock = true;
    }
  }
  return count;
}

function listTrackedFiles(dir) {
  if (!isDir(dir)) return [];
  if (isDir(path.join(dir, '.git'))) {
    const r = spawnSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (r.status === 0) return (r.stdout || '').split('\0').filter(Boolean);
  }

  const files = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  walk('');
  return files;
}

function readTextFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

function countCodeLinesInDir(dir) {
  const files = listTrackedFiles(dir);
  let lines = 0;
  for (const rel of files) {
    if (!isCodeFile(rel)) continue;
    const text = readTextFile(path.join(dir, rel));
    if (text === null) continue;
    lines += countCodeLines(text, commentStyleFor(rel));
  }
  return { lines, files: files.length };
}

function fileCount(dir) {
  return listTrackedFiles(dir).length;
}

// ---------------- tracker + scoring (unchanged behaviour) ----------------

async function downloadTracker() {
  const response = await fetchWithRetry(
    TRACKER_URL,
    { headers: { 'User-Agent': 'gta6-runners-sync' } },
    3,
    30000,
  );
  if (!response || !response.ok) {
    throw new Error(`tracker download failed: HTTP ${response ? response.status : 'network error'}`);
  }
  return response.json();
}

function extractRepos(tracker) {
  const picked = [];

  for (const effort of tracker.efforts || []) {
    const repo = effort && typeof effort.repo === 'string' ? effort.repo : null;
    if (!repo) continue;
    const text = [effort.id, effort.name, effort.approach || '', effort.target || '', effort.summary || '', effort.tier || ''].join(' ');
    const isWindows = MENTION.test(text);
    const isGta = /gta\s*6|gta6|gta\s*vi|grand theft auto vi|xbox series/i.test(text) || (effort.id && /gta|vi/i.test(effort.id));
    if (isWindows && isGta) picked.push({ repo, source: 'effort', id: effort.id });
  }

  for (const candidate of tracker.candidates || []) {
    if (!candidate || typeof candidate.repo !== 'string') continue;
    const text = [candidate.name || '', candidate.description || '', candidate.language || ''].join(' ');
    if (MENTION.test(text) || /gta\s*6|gta6|gta\s*vi|windows|xbox series|x64|native/i.test(text)) {
      picked.push({ repo: candidate.repo, source: 'candidate', id: candidate.name || null });
    }
  }

  const seen = new Set();
  const repos = [];
  for (const pick of picked) {
    if (seen.has(pick.repo)) continue;
    seen.add(pick.repo);
    repos.push(pick);
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  return repos;
}

function trackerObjectsByRepo(tracker) {
  const byRepo = new Map();
  for (const effort of tracker.efforts || []) if (effort && effort.repo) byRepo.set(effort.repo, effort);
  for (const candidate of tracker.candidates || []) if (candidate && candidate.repo) byRepo.set(candidate.repo, candidate);
  return byRepo;
}

function descriptionFor(entry, tracker, meta) {
  const byRepo = trackerObjectsByRepo(tracker);
  const obj = byRepo.get(entry.repo);
  let desc = '';
  if (obj) desc = obj.summary || obj.approach || obj.description || obj.name || '';
  if (!desc && meta && meta.description) desc = meta.description;
  return String(desc || entry.repo).slice(0, 160);
}

function completionScore(entry, tracker) {
  // Site definition (4lwayz/portwatch-vi, assets/js/scoring.js: scoreEffort):
  // efforts are scored 0-100 from ground work + ladder milestones + playing-well tracks.
  const byRepo = trackerObjectsByRepo(tracker);
  const obj = byRepo.get(entry.repo);
  if (!obj || !obj.gta) return null; // site scores efforts; candidates have no completion here
  return scoreEffort(obj).score;
}

const GROUNDWORK = [
  { key: 'loader', weight: 0.2 },
  { key: 'shaders', weight: 0.28 },
  { key: 'graphics', weight: 0.32 },
  { key: 'proven', weight: 0.2 },
];
const SITE_TRACKS = [
  { key: 'story', weight: 0.35 },
  { key: 'render', weight: 0.25 },
  { key: 'perf', weight: 0.2 },
  { key: 'stability', weight: 0.2 },
];
const SITE_STABILITY = { unknown: 0, constant: 0, often: 0.25, sometimes: 0.55, rarely: 0.8, stable: 1 };
const MILESTONES = [
  { key: 'groundwork', at: 0 },
  { key: 'loads', at: 10 },
  { key: 'boots', at: 20 },
  { key: 'menu', at: 30 },
  { key: 'world', at: 40 },
  { key: 'playable', at: 50 },
  { key: 'complete', at: 100 },
];
const SITE_TICK = Object.fromEntries(MILESTONES.map((milestone) => [milestone.key, milestone.at]));
const SITE_LADDER = ['loads', 'boots', 'menu', 'world', 'playable'];

const clamp01 = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

// GTA ladder values are 0 (no), 0.5 (partially) or 1 (yes).
function ladderValue(value) {
  if (value === true) return 1;
  if (value === false || value == null) return 0;
  return clamp01(value);
}

function groundworkFraction(groundwork) {
  return GROUNDWORK.reduce((sum, item) => sum + item.weight * clamp01(groundwork && groundwork[item.key]), 0);
}

function trackValues(gta = {}) {
  return {
    story: clamp01(gta.story),
    render: clamp01(gta.render),
    perf: clamp01((Number(gta.fps) || 0) / 30),
    stability:
      typeof gta.stability === 'number' ? clamp01(gta.stability) : (SITE_STABILITY[gta.stability] ?? SITE_STABILITY.unknown),
  };
}

function scoreEffort(effort) {
  if (!effort) return null;
  const gw = groundworkFraction(effort.groundwork);
  const gta = effort.gta || {};
  let score = SITE_TICK.loads * gw;
  let reached = 'groundwork';
  let prevTick = score;

  for (const key of SITE_LADDER) {
    const value = ladderValue(gta[key]);
    if (value >= 1) {
      score = SITE_TICK[key];
      prevTick = score;
      reached = key;
      continue;
    }
    if (value > 0) score = Math.max(score, prevTick + value * (SITE_TICK[key] - prevTick));
    break;
  }

  const tracks = trackValues(gta);
  const quality = SITE_TRACKS.reduce((sum, track) => sum + track.weight * tracks[track.key], 0);
  if (reached === 'playable') {
    score = SITE_TICK.playable + quality * (SITE_TICK.complete - SITE_TICK.playable);
    if (quality >= 1) reached = 'complete';
  }

  if (Number.isFinite(effort.manualScore)) score = Math.min(100, Math.max(0, effort.manualScore));
  return { score: Math.round(score * 10) / 10, reached };
}

function trackerArchived(tracker, repoPath) {
  for (const effort of tracker.efforts || []) {
    if (effort && effort.repo === repoPath && effort.stats && typeof effort.stats.archived === 'boolean') {
      return effort.stats.archived;
    }
  }
  return false;
}

// ---------------- repository metadata ----------------

async function fetchRepoMeta(repoPath) {
  const headers = { 'User-Agent': 'gta6-runners-sync', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchWithRetry(`https://api.github.com/repos/${repoPath}`, { headers }, 2, 15000);
  if (!response || !response.ok) return { archived: false, description: null };
  try {
    const json = await response.json();
    return {
      archived: Boolean(json.archived),
      description: typeof json.description === 'string' ? json.description : null,
    };
  } catch {
    return { archived: false, description: null };
  }
}

// ---------------- previous state + deployed archive fallback ----------------

async function fetchPreviousState() {
  const response = await fetchWithRetry(
    `${SITE_URL}runners.json`,
    { headers: { 'User-Agent': 'gta6-runners-sync' } },
    3,
    15000,
  );
  if (!response || !response.ok) return { repos: {}, metricVersion: null };
  try {
    const json = await response.json();
    const repos = {};
    for (const rec of json.repos || []) {
      if (rec && typeof rec.repo === 'string') repos[rec.repo] = rec;
    }
    return { repos, metricVersion: Number.isFinite(json.metricVersion) ? json.metricVersion : null };
  } catch {
    return { repos: {}, metricVersion: null };
  }
}

async function downloadSiteZip(name, prev) {
  const file = prev && typeof prev.archive === 'string' && prev.archive ? prev.archive : `${name}.zip`;
  const response = await fetchWithRetry(
    `${SITE_URL}archives/${encodeURIComponent(file)}`,
    { headers: { 'User-Agent': 'gta6-runners-sync' } },
    2,
    60000,
  );
  if (!response || !response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return null;
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const out = path.join(TMP_ROOT, `${name}.zip`);
  fs.writeFileSync(out, buffer);
  return out;
}

function extractZip(zipPath, destDir) {
  rmrf(destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { encoding: 'utf8', timeout: 180000 });
  return r.status === 0;
}

/** Materialize the previous copy from the deployed archives/ directory. */
async function ensureSiteCopy(name, prevState, goodDir) {
  if (!prevState || !prevState.archive) return false;
  const zip = await downloadSiteZip(name, prevState);
  if (!zip) return false;
  if (!extractZip(zip, goodDir)) return false;
  return true;
}

// ---------------- freeze / recovery decision ----------------

function decide(baseline, cur, observation, nowIso) {
  if (!Number.isFinite(baseline) || baseline <= 0) return { accept: true, observation: null };

  if (!observation) {
    if (cur < FREEZE_RATIO * baseline) {
      return {
        accept: false,
        observation: {
          baseline,
          last: cur,
          growth: 0,
          dead: cur < DEAD_RATIO * baseline,
          since: nowIso,
        },
      };
    }
    return { accept: true, observation: null };
  }

  const prev = Number.isFinite(observation.last) ? observation.last : cur;
  if (cur >= observation.baseline) return { accept: true, observation: null };

  const jumpPct = cur >= JUMP_RATIO * prev && cur - prev >= JUMP_MIN_LINES;
  const jumpAbs = cur - prev >= JUMP_ABS_LINES;

  let growth = Number.isFinite(observation.growth) ? observation.growth : 0;
  if (cur > prev) growth += 1;
  else if (cur < prev * GROWTH_RESET_RATIO) growth = 0;

  const next = {
    ...observation,
    last: cur,
    growth,
    dead: cur < DEAD_RATIO * observation.baseline,
  };

  if (jumpPct || jumpAbs || (!next.dead && next.growth >= GROWTH_TARGET)) {
    return { accept: true, observation: null };
  }
  return { accept: false, observation: next };
}

// ---------------- archive generation ----------------

function makeArchive(goodDir, name) {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
  const out = path.join(ARCHIVES_DIR, `${name}.zip`);
  if (isDir(path.join(goodDir, '.git'))) {
    const r = spawnSync('git', ['archive', '--format=zip', '-o', out, 'HEAD'], {
      cwd: goodDir,
      encoding: 'utf8',
      timeout: 180000,
    });
    if (r.status !== 0) {
      console.log(`  ! archive failed for ${name}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return null;
    }
  } else {
    const r = spawnSync('zip', ['-q', '-r', out, '.', '-x', '.git/*'], {
      cwd: goodDir,
      encoding: 'utf8',
      timeout: 180000,
    });
    if (r.status !== 0) {
      console.log(`  ! archive failed for ${name}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return null;
    }
  }
  return path.basename(out);
}

// ---------------- per-repository sync ----------------

async function syncRepo(entry, prevState, tracker, name, tools) {
  const rec = {
    repo: entry.repo,
    source: entry.source,
    id: entry.id || null,
    branch: null,
    headSha: null,
    cacheSha: null,
    status: 'inaccessible',
    files: 0,
    codeLines: null,
    archiveLines: null,
    observation: null,
    anomalies: [],
    error: false,
    archive: null,
    description: null,
    completion: null,
    archived: false,
    sourceOnly: false,
  };

  const goodDir = path.join(GOOD_ROOT, name);
  const workDir = path.join(WORK_ROOT, name);
  const prefix = `${CACHE_KEY_PREFIX}${name}-`;

  let remote = await lsRemote(entry.repo);
  rec.branch = (remote && remote.branch) || (prevState && prevState.branch) || null;
  rec.headSha = (remote && remote.sha) || (prevState && prevState.headSha) || null;
  rec.cacheSha = (prevState && prevState.cacheSha) || null;
  rec.observation = (prevState && prevState.observation) || null;

  const primary = `${prefix}${(remote && remote.sha) || rec.cacheSha || 'last'}`;
  const restoredKey = await tools.restore(goodDir, primary, prefix);
  let hasGood = Boolean(restoredKey) && isDir(goodDir);
  if (!hasGood) rmrf(goodDir);
  rec.sourceOnly = hasGood && !isDir(path.join(goodDir, '.git'));

  let baseline = prevState && Number.isFinite(prevState.archiveLines) ? prevState.archiveLines : null;
  if (baseline === null && hasGood) baseline = countCodeLinesInDir(goodDir).lines;

  const prevAnomalies = (prevState && Array.isArray(prevState.anomalies) && prevState.anomalies) || [];
  const needsSiteCopy =
    !hasGood &&
    (prevAnomalies.includes('code_deleted') ||
      prevAnomalies.includes('disappeared') ||
      (prevState && prevState.status === 'inaccessible'));

  let siteCopyFetched = false;
  if (needsSiteCopy) {
    const zip = await downloadSiteZip(name, prevState);
    if (zip && extractZip(zip, goodDir)) {
      hasGood = true;
      siteCopyFetched = true;
      rec.sourceOnly = true;
      if (baseline === null) baseline = countCodeLinesInDir(goodDir).lines;
      console.log(`  ~ ${entry.repo}: cache miss, seeded from the deployed archive`);
    }
  }

  let cur = null;
  let cloned = false;

  if (remote) {
    const unchanged = Boolean(prevState) && remote.sha === prevState.headSha && hasGood;
    if (unchanged && Number.isFinite(prevState.codeLines)) {
      cur = prevState.codeLines;
    } else if (unchanged && baseline !== null) {
      cur = baseline;
    } else {
      cloned = await cloneRepo(entry.repo, remote.branch, workDir);
      if (cloned) {
        cur = countCodeLinesInDir(workDir).lines;
      } else {
        remote = null;
      }
    }
  }

  if (remote && cur !== null) {
    rec.status = 'accessible';
    if (baseline === null || !Number.isFinite(baseline) || baseline <= 0) baseline = cur;

    const decision = decide(baseline, cur, rec.observation, new Date().toISOString());

    if (decision.accept) {
      rec.observation = null;
      rec.archiveLines = cur;
      rec.codeLines = cur;
      if (cloned) {
        rmrf(goodDir);
        fs.renameSync(workDir, goodDir);
        hasGood = true;
        rec.sourceOnly = false;
        rec.cacheSha = remote.sha;
        if (!(await tools.save(goodDir, `${prefix}${remote.sha}`))) {
          console.log(`  ! ${entry.repo}: accepted copy was not persisted to the cache`);
        }
      } else {
        rec.cacheSha = (prevState && prevState.cacheSha) || remote.sha;
        if (siteCopyFetched) {
          // The cache entry was missing but the deployed archive was usable:
          // persist it so the next run does not have to download it again.
          if (await tools.save(goodDir, `${prefix}${remote.sha}`)) rec.cacheSha = remote.sha;
        }
      }
    } else {
      rec.observation = decision.observation;
      rec.archiveLines = baseline;
      rec.codeLines = cur;
      rec.cacheSha = (prevState && prevState.cacheSha) || null;
      if (cloned) rmrf(workDir);
      if (!hasGood && (await ensureSiteCopy(name, prevState, goodDir))) {
        // The cache entry was evicted between runs: recover the previous copy
        // from the deployed archives so the freeze still has something to serve.
        hasGood = true;
        siteCopyFetched = true;
        rec.sourceOnly = true;
        if (rec.archiveLines === null) rec.archiveLines = countCodeLinesInDir(goodDir).lines;
      }
      if (siteCopyFetched) {
        const keySha = remote.sha || (prevState && prevState.headSha) || 'src';
        if (await tools.save(goodDir, `${prefix}${keySha}`)) rec.cacheSha = keySha;
      }
    }
  } else {
    rec.status = 'inaccessible';
    rec.anomalies.push('disappeared');
    rec.error = true;
    rec.codeLines = prevState && Number.isFinite(prevState.codeLines) ? prevState.codeLines : null;
    rec.observation = (prevState && prevState.observation) || null;
    rec.archiveLines = baseline;
    rec.cacheSha = (prevState && prevState.cacheSha) || null;
    if (!hasGood && (await ensureSiteCopy(name, prevState, goodDir))) {
      // The repository vanished while its cache entry was missing: keep the
      // copy that the previous deployment was serving.
      hasGood = true;
      siteCopyFetched = true;
      rec.sourceOnly = true;
      if (rec.archiveLines === null) rec.archiveLines = countCodeLinesInDir(goodDir).lines;
    }
    if (siteCopyFetched) {
      const keySha = (prevState && prevState.headSha) || 'src';
      if (await tools.save(goodDir, `${prefix}${keySha}`)) rec.cacheSha = keySha;
    }
  }

  const meta = await fetchRepoMeta(entry.repo);
  rec.archived = meta.archived || trackerArchived(tracker, entry.repo);
  if (rec.archived) rec.anomalies.push('frozen');

  if (rec.observation) {
    rec.anomalies.push('code_deleted');
    rec.error = true;
    if (rec.observation.dead) rec.anomalies.push('unrecoverable');
  }

  rec.description = descriptionFor(entry, tracker, meta);
  rec.completion = completionScore(entry, tracker);

  if (hasGood) {
    rec.files = fileCount(goodDir);
    rec.sourceOnly = !isDir(path.join(goodDir, '.git'));
    if (rec.archiveLines === null) rec.archiveLines = countCodeLinesInDir(goodDir).lines;
    rec.archive = makeArchive(goodDir, name);
  } else if (rec.observation) {
    console.log(`  ! ${entry.repo}: frozen without a good copy (deployed archive unavailable)`);
  }

  return rec;
}

// ---------------- page generation ----------------

function htmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtNum(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return Number(value).toLocaleString('en-US');
}

function sortedResults(results) {
  return [...results].sort((a, b) => ((b.completion ?? 0) - (a.completion ?? 0)) || a.repo.localeCompare(b.repo));
}

function observationCell(rec) {
  if (!rec.observation) return '-';
  if (rec.observation.dead) return '<span class="badge anom">不可恢复</span>';
  return `${rec.observation.growth}/3`;
}

function generatePages(results) {
  const rows = sortedResults(results)
    .map((rec) => {
      const desc = (rec.description || rec.repo).slice(0, 140);
      const statusBadge =
        rec.status === 'accessible'
          ? '<span class="badge ok">可访问</span>'
          : '<span class="badge bad">不可访问</span>';
      const anomalyBadges = rec.anomalies
        .map((anomaly) => `<span class="badge anom">${htmlEscape(ANOMALY_LABELS[anomaly] || anomaly)}</span>`)
        .join(' ');
      const archive = rec.archive ? `<a href="archives/${rec.archive}" download>下载副本</a>` : '-';
      const completion = rec.completion === null || rec.completion === undefined ? '-' : `${rec.completion}%`;
      return `  <tr>
    <td><a href="https://github.com/${htmlEscape(rec.repo)}" target="_blank" rel="noopener">${htmlEscape(rec.repo)}</a></td>
    <td>${statusBadge}${anomalyBadges}</td>
    <td class="desc">${htmlEscape(desc)}</td>
    <td class="num">${completion}</td>
    <td>${htmlEscape(rec.branch || '-')}</td>
    <td class="num">${rec.files || 0}</td>
    <td class="num">${fmtNum(rec.codeLines)}</td>
    <td class="num">${fmtNum(rec.archiveLines)}</td>
    <td class="num">${observationCell(rec)}</td>
    <td>${archive}</td>
  </tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GTA6 Windows 运行器 - 状态与信息</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 82rem; padding: 0 1rem; }
h1 { font-size: 1.5rem; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { border: 1px solid #ddd; padding: 0.45rem 0.6rem; text-align: left; font-size: 0.9rem; vertical-align: top; }
th { background: #f5f5f5; }
th.num, td.num { text-align: right; min-width: 4.5rem; }
td.desc { min-width: 16rem; }
.meta { color: #444; font-size: 0.9rem; }
.meta b { color: #111; }
.badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.6rem; font-size: 0.75rem; margin: 0 0.2rem; white-space: nowrap; }
.badge.ok { background: #dcfce7; color: #15803d; }
.badge.bad { background: #fee2e2; color: #b91c1c; }
.badge.anom { background: #fef3c7; color: #b45309; }
.note, .legend { color: #555; font-size: 0.85rem; }
code { background: #f5f5f5; padding: 0.1rem 0.2rem; border-radius: 0.2rem; }
</style>
</head>
<body>
<h1>GTA6 Windows 运行器代码仓库</h1>
<div class="meta">
  <span>总仓库数：<b>${results.length}</b></span>
  <span>可访问：<b>${results.filter((rec) => rec.status === 'accessible').length}</b></span>
  <span>异常仓库：<b>${results.filter((rec) => rec.anomalies.length).length}</b></span>
  <span>错误标记：<b>${results.filter((rec) => rec.error).length}</b></span>
  <span>生成时间：<b>${htmlEscape(new Date().toISOString())}</b></span>
</div>
<p class="note">页面由 <code>scripts/gta6-windows-runner-sync.mjs</code> 生成（workflow_dispatch 触发）。仓库地址指向 GitHub；副本压缩包仅供下载（点击即下载，不会跳转）。<b>当前行数</b>为远端最新提交的有效代码行（不含空行和整行注释），<b>归档行数</b>为页面提供下载的副本的行数，<b>观察</b>为缩水后的恢复进度。</p>
<table>
  <thead>
    <tr><th>仓库地址</th><th>状态与异常</th><th>项目说明</th><th>完成度</th><th>分支</th><th>文件数</th><th>当前行数</th><th>归档行数</th><th>观察</th><th>副本下载</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="legend">图例：<b class="badge ok">可访问</b> 可正常获取；<b class="badge bad">不可访问</b> 当前无法获取（消失）；<b class="badge anom">代码大量删除</b> 有效行数跌破基线的 40%，已冻结为旧副本；<b class="badge anom">消失</b> 仓库已消失；<b class="badge anom">冻结</b> 已归档或其他异常状态；<b class="badge anom">不可恢复</b> 有效行数跌破基线的 5%。</p>
</body>
</html>`;

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(INDEX_HTML, html);

  const runnersJson = {
    schema: 2,
    metricVersion: METRIC_VERSION,
    generatedAt: new Date().toISOString(),
    trackerUrl: TRACKER_URL,
    total: results.length,
    accessible: results.filter((rec) => rec.status === 'accessible').length,
    anomalies: results.filter((rec) => rec.anomalies.length).length,
    errors: results.filter((rec) => rec.error).length,
    repos: sortedResults(results).map((rec) => ({
      repo: rec.repo,
      source: rec.source,
      id: rec.id,
      branch: rec.branch,
      status: rec.status,
      headSha: rec.headSha,
      cacheSha: rec.cacheSha,
      files: rec.files,
      codeLines: rec.codeLines,
      archiveLines: rec.archiveLines,
      observation: rec.observation,
      anomalies: rec.anomalies,
      error: rec.error,
      archive: rec.archive || null,
      description: rec.description,
      completion: rec.completion,
      sourceOnly: rec.sourceOnly,
    })),
  };
  fs.writeFileSync(RUNNERS_JSON, JSON.stringify(runnersJson, null, 2));
}

// ---------------- names ----------------

function assignNames(entries) {
  const names = new Map();
  const used = new Set();
  for (const entry of entries) {
    let name = entry.repo.replace(/[^A-Za-z0-9_-]/g, '__');
    if (used.has(name)) {
      name = `${name}-${crypto.createHash('sha1').update(entry.repo).digest('hex').slice(0, 8)}`;
    }
    used.add(name);
    names.set(entry.repo, name);
  }
  return names;
}

// ---------------- main ----------------

async function main() {
  const tools = makeCacheTools();

  rmrf(CACHE_ROOT);
  fs.mkdirSync(GOOD_ROOT, { recursive: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  rmrf(DIST_DIR);
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });

  const tracker = await downloadTracker();
  const entries = extractRepos(tracker);
  if (!entries.length) throw new Error('tracker produced no repositories');

  const names = assignNames(entries);
  const previous = await fetchPreviousState();
  if (previous.metricVersion !== null && previous.metricVersion !== METRIC_VERSION) {
    console.warn(`WARN: metric version changed (${previous.metricVersion} -> ${METRIC_VERSION}); baselines will be re-counted.`);
    for (const rec of Object.values(previous.repos)) {
      delete rec.archiveLines;
      delete rec.observation;
      delete rec.codeLines;
    }
  }

  console.log(
    `Repositories: ${entries.length}; previous state: ${Object.keys(previous.repos).length}; cache: ${tools.enabled ? 'on' : 'off'}`,
  );

  const results = [];
  for (const entry of entries) {
    const name = names.get(entry.repo);
    let rec;
    try {
      rec = await syncRepo(entry, previous.repos[entry.repo] || null, tracker, name, tools);
    } catch (error) {
      console.error(`  ! ${entry.repo}: ${error.message}`);
      rec = {
        repo: entry.repo,
        source: entry.source,
        id: entry.id || null,
        branch: null,
        headSha: null,
        cacheSha: null,
        status: 'inaccessible',
        files: 0,
        codeLines: null,
        archiveLines: null,
        observation: null,
        anomalies: ['disappeared'],
        error: true,
        archive: null,
        description: entry.repo,
        completion: null,
        archived: false,
        sourceOnly: false,
      };
    }
    results.push(rec);

    const anomalies = rec.anomalies.length ? ` [${rec.anomalies.join('/')}]` : '';
    const obs = rec.observation ? (rec.observation.dead ? ' dead' : ` obs=${rec.observation.growth}/3`) : '';
    console.log(
      `${rec.status === 'accessible' ? 'OK  ' : 'BAD '} ${rec.repo}${anomalies} files=${rec.files} lines=${rec.codeLines ?? '-'}/${rec.archiveLines ?? '-'}${obs}`,
    );
  }

  rmrf(WORK_ROOT);

  generatePages(results);

  const accessible = results.filter((rec) => rec.status === 'accessible').length;
  const errorCount = results.filter((rec) => rec.error).length;
  console.log(
    `\nDone: ${results.length} repos, ${accessible} accessible, ${errorCount} with error flags. Pages: dist/index.html, dist/runners.json`,
  );
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
