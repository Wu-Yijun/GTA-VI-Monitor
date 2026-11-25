#!/usr/bin/env node
/**
 * scripts/gta6-windows-runner-sync.mjs
 *
 * Run on the Linux runner by .github/workflows/gta6-windows-runners.yml (workflow_dispatch).
 *
 * Every run:
 *   1. Downloads https://portwatch-vi.xyz/data/tracker.json (always fresh, every run).
 *   2. Extracts the GTA VI Windows-runner repositories (efforts + candidates).
 *   3. Downloads/updates each repository into `.cache/repos/<owner>__<name>`
 *      (per-repo cache). Repository resources only grow, never shrink:
 *      when the remote code count is smaller than the cached copy's count
 *      (or the repo is inaccessible), the cached copy is kept.
 *   4. Records an error flag and an anomaly label:
 *        - 消失 (disappeared): repo not found / not accessible.
 *        - 代码大量删除 (code_deleted): effective code count shrank.
 *        - 冻结 (frozen): repo is archived (tracker stats or GitHub page)
 *          or another abnormal state.
 *   5. Packs each repository copy into `dist/archives/<owner>__<name>.zip`.
 *   6. Generates a static page `dist/index.html` (status + info + description +
 *      completion level + download-only links to the archives) and
 *      `dist/runners.json` (machine readable details).
 *   7. Rows are sorted by completion level when the tracker provides it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TRACKER_URL = 'https://portwatch-vi.xyz/data/tracker.json';
const CACHE_DIR = path.join(ROOT, '.cache');
const REPOS_CACHE_DIR = path.join(CACHE_DIR, 'repos');
const STATE_FILE = path.join(CACHE_DIR, 'state', 'gta6-runners.json');
const DIST_DIR = path.join(ROOT, 'dist');
const ARCHIVES_DIR = path.join(DIST_DIR, 'archives');
const RUNNERS_JSON = path.join(DIST_DIR, 'runners.json');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const SAVED_TRACKER = path.join(CACHE_DIR, 'tracker.json');

const ANOMALY_LABELS = { code_deleted: '代码大量删除', disappeared: '消失', frozen: '冻结' };
const MENTION = /windows|native|wine|translation|compat|runtime|layer|emulator|shim|hook|x64|rust/i;

// ---------------- small helpers ----------------

function git(args, cwd, timeout = 120000) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout, cwd });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'git failed').toString().trim().slice(0, 500));
  }
  return r.stdout || '';
}

function gitTry(args, cwd, timeout = 120000) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout, cwd });
  return r.status === 0 ? r.stdout || '' : '';
}

function lsFilesCount(dir) {
  return gitTry(['ls-files'], dir)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function lsTreeCount(dir, ref) {
  if (!ref) return -1;
  return gitTry(['ls-tree', '-r', '--name-only', ref], dir)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function lsTopLevel(dir) {
  return gitTry(['ls-tree', '--name-only', 'HEAD'], dir)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function headSha(repoPath) {
  const out = gitTry(['ls-remote', `https://github.com/${repoPath}`], null, 60000);
  const m = out.match(/^[0-9a-f]{40}\s+HEAD/m);
  return m ? m[0].split(/\s+/)[0] : null;
}

function defaultBranch(repoPath) {
  const out = git(['ls-remote', '--symref', `https://github.com/${repoPath}`], null, 60000);
  const m = out.match(/ref:\s*refs\/heads\/(\S+)\s+HEAD/);
  if (!m) throw new Error('ls-remote output has no HEAD symref');
  return m[1];
}

function dirFor(repo) {
  return path.join(REPOS_CACHE_DIR, repo.replace(/[^A-Za-z0-9_-]/g, '__'));
}

async function downloadTracker() {
  const r = await fetch(TRACKER_URL, { headers: { 'User-Agent': 'gta6-runners-sync' } });
  if (!r.ok) throw new Error(`tracker download failed: HTTP ${r.status}`);
  const text = await r.text();
  fs.mkdirSync(path.dirname(SAVED_TRACKER), { recursive: true });
  fs.writeFileSync(SAVED_TRACKER, text);
  return JSON.parse(text);
}

// ---------------- GitHub page info (description + archived) ----------------

async function fetchRepoPageInfo(repoPath) {
  const out = { description: null, archived: false, ok: false };
  try {
    const r = await fetch(`https://github.com/${repoPath}`, {
      headers: { 'User-Agent': 'gta6-runners-sync' },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return out;
    const text = await r.text();
    const m = text.match(/<script type="application\/json" data-target="react-app.embeddedData">([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const p = j.payload || {};
        const about = p.sidebarAbout || (p.codeViewRepoRoute && p.codeViewRepoRoute.overview && p.codeViewRepoRoute.overview.sidebarAboutData);
        if (about && typeof about.description === 'string' && about.description) {
          out.description = about.description.slice(0, 160);
        }
        const collect = (o, depth) => {
          if (!o || depth > 8 || Object.keys(o).length === 0) return;
          if (typeof o.isArchived === 'boolean') out.archived = out.archived || o.isArchived;
          for (const v of Object.values(o)) if (v && typeof v === 'object') collect(v, depth + 1);
        };
        collect(j, 0);
        if (!out.description) {
          const dm = text.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/);
          const dm2 = dm ? null : text.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/);
          const d = dm ? dm[1] : dm2 && dm2[1];
          if (d) out.description = d.slice(0, 160);
        }
      } catch { /* ignore parse errors */ }
    }
    out.ok = true;
  } catch { /* network errors: leave defaults */ }
  return out;
}

// ---------------- extraction of GTA6 Windows-runner repos ----------------

function extractRepos(tracker) {
  const picked = [];

  for (const e of tracker.efforts || []) {
    const repo = e && typeof e.repo === 'string' ? e.repo : null;
    if (!repo) continue;
    const text = [e.id, e.name, e.approach || '', e.target || '', e.summary || '', e.tier || ''].join(' ');
    const isWindows = MENTION.test(text);
    const isGta = /gta\s*6|gta6|gta\s*vi|grand theft auto vi|xbox series/i.test(text) || (e.id && /gta|vi/i.test(e.id));
    if (isWindows && isGta) picked.push({ repo, source: 'effort', id: e.id });
  }

  for (const c of tracker.candidates || []) {
    if (!c || typeof c.repo !== 'string') continue;
    const text = [c.name || '', c.description || '', c.language || ''].join(' ');
    if (MENTION.test(text) || /gta\s*6|gta6|gta\s*vi|windows|xbox series|x64|native/i.test(text)) {
      picked.push({ repo: c.repo, source: 'candidate', id: c.name || null });
    }
  }

  const seen = new Set();
  const repos = [];
  for (const p of picked) {
    if (seen.has(p.repo)) continue;
    seen.add(p.repo);
    repos.push(p);
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  return repos;
}

function trackerObjectsByRepo(tracker) {
  const byRepo = new Map();
  for (const e of tracker.efforts || []) if (e && e.repo) byRepo.set(e.repo, e);
  for (const c of tracker.candidates || []) if (c && c.repo) byRepo.set(c.repo, c);
  return byRepo;
}

function descriptionFor(entry, tracker, pageInfo) {
  const byRepo = trackerObjectsByRepo(tracker);
  const obj = byRepo.get(entry.repo);
  let desc = '';
  if (obj) {
    desc = obj.summary || obj.approach || obj.description || obj.name || '';
  }
  if (!desc && pageInfo && pageInfo.description) desc = pageInfo.description;
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

// ---------------- site scoring (port of 4lwayz/portwatch-vi, assets/js/scoring.js) ----------------

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
const SITE_TICK = Object.fromEntries(MILESTONES.map((m) => [m.key, m.at]));
const SITE_LADDER = ['loads', 'boots', 'menu', 'world', 'playable'];

const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

// GTA ladder values are 0 (no), 0.5 (partially) or 1 (yes).
function ladderValue(v) {
  if (v === true) return 1;
  if (v === false || v == null) return 0;
  return clamp01(v);
}

function groundworkFraction(gw) {
  return GROUNDWORK.reduce((sum, g) => sum + g.weight * clamp01(gw && gw[g.key]), 0);
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
    const v = ladderValue(gta[key]);
    if (v >= 1) {
      score = SITE_TICK[key];
      prevTick = score;
      reached = key;
      continue;
    }
    if (v > 0) score = Math.max(score, prevTick + v * (SITE_TICK[key] - prevTick));
    break;
  }

  const tracks = trackValues(gta);
  const quality = SITE_TRACKS.reduce((sum, tr) => sum + tr.weight * tracks[tr.key], 0);
  if (reached === 'playable') {
    score = SITE_TICK.playable + quality * (SITE_TICK.complete - SITE_TICK.playable);
    if (quality >= 1) reached = 'complete';
  }

  if (Number.isFinite(effort.manualScore)) score = Math.min(100, Math.max(0, effort.manualScore));
  return { score: Math.round(score * 10) / 10, reached };
}

function trackerArchived(tracker, repoPath) {
  for (const e of tracker.efforts || []) {
    if (e && e.repo === repoPath && e.stats && typeof e.stats.archived === 'boolean') {
      return e.stats.archived;
    }
  }
  return false;
}

// ---------------- per-repo sync ----------------

async function syncRepo(entry, state, tracker) {
  const rec = {
    repo: entry.repo,
    source: entry.source,
    id: entry.id || null,
    branch: null,
    headSha: null,
    status: 'inaccessible',
    files: 0,
    anomalies: [],
    error: false,
    archive: null,
    description: null,
    completion: null,
    archived: false,
    dir: path.relative(ROOT, dirFor(entry.repo)),
    topLevel: [],
  };
  const dir = dirFor(entry.repo);
  const gitDir = path.join(dir, '.git');
  const prev = (state.repos || {})[entry.repo] || null;

  // Accessibility + default branch (fresh every run).
  try {
    rec.branch = defaultBranch(entry.repo);
  } catch {
    rec.branch = null;
  }
  rec.headSha = headSha(entry.repo);

  // Clone or update.
  if (!fs.existsSync(gitDir)) {
    try {
      git(['clone', '--quiet', '--depth', '1', '--branch', rec.branch || 'main', `https://github.com/${entry.repo}`, dir], null, 180000);
      rec.status = 'accessible';
    } catch {
      rec.status = 'inaccessible';
      rec.anomalies.push('disappeared');
      rec.error = true;
    }
  } else {
    try {
      git(['fetch', '--quiet', 'origin'], dir, 180000);
      rec.status = 'accessible';
    } catch {
      rec.status = 'inaccessible';
      rec.anomalies.push('disappeared');
      rec.error = true;
    }
  }

  if (rec.status === 'inaccessible') {
    // Keep whatever is cached so the page can still offer a copy of the repo.
    rec.files = lsFilesCount(dir);
    rec.topLevel = lsTopLevel(dir);
    rec.description = descriptionFor(entry, tracker, null);
    rec.completion = completionScore(entry, tracker);
    rec.archived = trackerArchived(tracker, entry.repo);
    if (rec.archived) rec.anomalies.push('frozen');
    return rec;
  }

  // Detect shrink before updating: remote count vs cached count.
  const localCount = lsFilesCount(dir);
  const remoteCount = lsTreeCount(dir, `origin/${rec.branch}`);
  const prevFiles = prev ? prev.files : -1;

  let shrunk = remoteCount >= 0 && remoteCount < localCount;
  if (!shrunk && prevFiles >= 0 && remoteCount >= 0 && remoteCount < prevFiles) shrunk = true;

  if (shrunk) {
    rec.anomalies.push('code_deleted');
    rec.error = true; // 使用缓存而非更新，并标记错误
    // Do not update: keep the cached copy (repository resources only grow).
  } else {
    try {
      git(['reset', '--quiet', '--hard', `origin/${rec.branch}`], dir, 180000);
    } catch {
      /* keep cache if update fails */
    }
    rec.files = lsFilesCount(dir);
    if (prevFiles >= 0 && rec.files < prevFiles) {
      rec.anomalies.push('code_deleted');
      rec.error = true;
    }
  }

  // Frozen = archived or other abnormal states (not "unchanged").
  const pageInfo = await fetchRepoPageInfo(entry.repo);
  rec.archived = pageInfo.archived || trackerArchived(tracker, entry.repo);
  if (rec.archived) rec.anomalies.push('frozen');

  rec.description = descriptionFor(entry, tracker, pageInfo);
  rec.completion = completionScore(entry, tracker);
  rec.topLevel = lsTopLevel(dir);
  return rec;
}

// ---------------- state ----------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: 1, repos: {} };
  }
}

function writeState(results) {
  const now = new Date().toISOString();
  const out = { version: 1, updatedAt: now, repos: {} };
  for (const r of results) {
    out.repos[r.repo] = {
      files: r.files,
      headSha: r.headSha || null,
      status: r.status,
      anomalies: r.anomalies,
      lastSeenAt: now,
    };
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
  return out;
}

// ---------------- zipping ----------------

function zipRepos(results) {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
  for (const rec of results) {
    const dir = dirFor(rec.repo);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const zipPath = path.join(ARCHIVES_DIR, `${rec.repo.replace(/[^A-Za-z0-9_-]/g, '__')}.zip`);
    const r = spawnSync('zip', ['-q', '-r', zipPath, '.', '-x', '.git/*'], { cwd: dir, timeout: 180000 });
    if (r.status === 0) {
      rec.archive = path.basename(zipPath);
    } else {
      console.log(`  ! zip failed for ${rec.repo}: ${String(r.stderr || r.stdout || '').slice(0, 200)}`);
    }
  }
}

// ---------------- static page generation ----------------

function htmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sortedResults(results) {
  // Sort by completion level when available (descending), then repo path.
  return [...results].sort((a, b) => ((b.completion ?? 0) - (a.completion ?? 0)) || a.repo.localeCompare(b.repo));
}

function generatePages(results) {
  const rows = sortedResults(results)
    .map((r) => {
      const desc = (r.description || r.repo).slice(0, 140);
      const statusBadge = r.status === 'accessible' ? '<span class="badge ok">可访问</span>' : '<span class="badge bad">不可访问</span>';
      const anomalyBadges = r.anomalies.map((a) => `<span class="badge anom">${htmlEscape(ANOMALY_LABELS[a] || a)}</span>`).join(' ');
      const archive = r.archive ? `<a href="archives/${r.archive}" download>下载副本</a>` : '-';
      const completion = r.completion === null || r.completion === undefined ? '-' : `${r.completion}%`;
      return `  <tr>
    <td><a href="https://github.com/${htmlEscape(r.repo)}" target="_blank" rel="noopener">${htmlEscape(r.repo)}</a></td>
    <td>${statusBadge}${anomalyBadges}</td>
    <td class="desc">${htmlEscape(desc)}</td>
    <td class="num">${completion}</td>
    <td>${htmlEscape(r.branch || '-')}</td>
    <td class="num">${r.files || 0}</td>
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
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
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
  <span>可访问：<b>${results.filter((r) => r.status === 'accessible').length}</b></span>
  <span>异常仓库：<b>${results.filter((r) => r.anomalies.length).length}</b></span>
  <span>错误标记：<b>${results.filter((r) => r.error).length}</b></span>
  <span>生成时间：<b>${htmlEscape(new Date().toISOString())}</b></span>
</div>
<p class="note">页面由 <code>scripts/gta6-windows-runner-sync.mjs</code> 生成（workflow_dispatch 触发）。仓库地址指向 GitHub；副本压缩包仅供下载（点击即下载，不会跳转）。</p>
<table>
  <thead>
    <tr><th>仓库地址</th><th>状态与异常</th><th>项目说明</th><th>完成度</th><th>分支</th><th>文件数</th><th>副本下载</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="legend">图例：<b class="badge ok">可访问</b> 可正常获取；<b class="badge bad">不可访问</b> 当前无法获取（消失）；<b class="badge anom">代码大量删除</b> 有效代码数量缩小；<b class="badge anom">消失</b> 仓库已消失；<b class="badge anom">冻结</b> 已归档或其他异常状态。</p>
</body>
</html>`;

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(INDEX_HTML, html);

  const runnersJson = {
    generatedAt: new Date().toISOString(),
    trackerUrl: TRACKER_URL,
    total: results.length,
    accessible: results.filter((r) => r.status === 'accessible').length,
    anomalies: results.filter((r) => r.anomalies.length).length,
    errors: results.filter((r) => r.error).length,
    repos: sortedResults(results).map((r) => ({
      repo: r.repo,
      source: r.source,
      id: r.id,
      branch: r.branch,
      status: r.status,
      files: r.files,
      description: r.description,
      completion: r.completion,
      anomalies: r.anomalies,
      error: r.error,
      archive: r.archive || null,
      headSha: r.headSha,
      dir: r.dir,
      topLevel: r.topLevel,
    })),
  };
  fs.writeFileSync(RUNNERS_JSON, JSON.stringify(runnersJson, null, 2));
}

// ---------------- main ----------------

async function main() {
  const tracker = await downloadTracker();
  const entries = extractRepos(tracker);
  fs.mkdirSync(REPOS_CACHE_DIR, { recursive: true });

  const state = readState();
  const results = [];
  for (const entry of entries) {
    const rec = await syncRepo(entry, state, tracker);
    results.push(rec);
    const tag = rec.anomalies.length ? ` [${rec.anomalies.join('/')}]` : '';
    console.log(`${rec.status === 'accessible' ? 'OK  ' : 'BAD '} ${rec.repo}${tag} files=${rec.files} completion=${rec.completion}`);
  }

  writeState(results);
  zipRepos(results);
  generatePages(results);

  const accessible = results.filter((r) => r.status === 'accessible').length;
  const errorCount = results.filter((r) => r.error).length;
  console.log(`\nDone: ${results.length} repos, ${accessible} accessible, ${errorCount} with error flags. Pages: dist/index.html, dist/runners.json`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
