#!/usr/bin/env node
/**
 * Plugin Configurator
 * ---------------------------------------------------------------------------
 * A local-only dev tool for RPG Maker MV and MZ projects that:
 *   1. Syncs plugin files into the game's js/plugins folder from two sources -
 *      a "global" folder (plugins shared across every game you work on) and a
 *      "game-specific" folder (plugins meant only for this one game) -
 *      copying any that are missing and overwriting any that are outdated
 *      (compared by content hash, not by date). A file present in both
 *      folders is taken from the game-specific one (it overrides the global
 *      version for this game only).
 *   2. Remembers, per game root, which global/game-specific folder pair you
 *      used last time as a "profile" - so switching back to a game you've
 *      already configured doesn't mean re-picking folders or re-disabling
 *      plugins that actually belong to some other game.
 *   3. Parses each plugin's @param header block to build a parameter schema.
 *   4. Serves a small local web GUI to view/edit those parameters and each
 *      plugin's enabled/disabled status, reading and writing js/plugins.js
 *      directly (no RPG Maker editor required).
 *
 * Usage:
 *   node plugin_configurator.js [gameRoot] [globPluginsDir] [specificPluginsDir] [port]
 *
 *   gameRoot            Path to the game's root folder (contains js/plugins.js).
 *                        Defaults to the user's Downloads folder.
 *   globPluginsDir       Folder of plugins shared across every game.
 *                        Defaults to a saved profile's value if gameRoot
 *                        matches one, else a "global-plugins" folder next to
 *                        this script.
 *   specificPluginsDir   Folder of plugins meant only for this one game.
 *                        Defaults to a saved profile's value if gameRoot
 *                        matches one, else a "game-plugins/<game folder
 *                        name>" folder next to this script (created
 *                        automatically if it doesn't exist yet).
 *   port                 Local server port. Defaults to 8420.
 *
 * Profiles: every time you successfully switch to a set of folders (at
 * startup or via the GUI), the (gameRoot -> globPluginsDir,
 * specificPluginsDir) pairing is saved to profiles.json next to this script.
 * Point the tool at that same game root again later and its folders come
 * back automatically - see the GUI's "Known games" list to switch between
 * games you've already set up.
 *
 * Not intended to be shipped to players - dev/testing tool only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

// ---------------------------------------------------------------------------
// Profiles (remembers glob/specific folders per game root)
// ---------------------------------------------------------------------------

const profilesFile = path.join(__dirname, 'profiles.json');

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveProfile(gameRoot, globPluginsDir, specificPluginsDir) {
  const profiles = loadProfiles();
  profiles[gameRoot] = { globPluginsDir, specificPluginsDir, lastUsed: new Date().toISOString() };
  try {
    fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2), 'utf8');
  } catch (e) {
    console.warn(`Warning: could not save profile: ${e.message}`);
  }
}

// Shapes the saved profiles into the array the GUI's "Known games" list
// renders from, most recently used first.
function listProfilesForGui() {
  const profiles = loadProfiles();
  return Object.keys(profiles)
    .map((gameRootKey) => ({
      gameRoot: gameRootKey,
      label: path.basename(gameRootKey),
      globPluginsDir: profiles[gameRootKey].globPluginsDir,
      specificPluginsDir: profiles[gameRootKey].specificPluginsDir,
      lastUsed: profiles[gameRootKey].lastUsed || '',
    }))
    .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
}

// ---------------------------------------------------------------------------
// CLI args / paths
// ---------------------------------------------------------------------------

let port = parseInt(process.argv[5], 10) || 8420;

const initialGameRoot = path.resolve(process.argv[2] || path.join(os.homedir(), 'Downloads'));
const existingProfile = loadProfiles()[initialGameRoot];

// `state` holds the active paths. Unlike the old top-level consts, these can
// change after the server has started (see /set-paths), so every function
// below reads state.gameRoot / state.globPluginsDir / state.specificPluginsDir
// rather than a closed-over const.
const state = {
  gameRoot: initialGameRoot,
  globPluginsDir: path.resolve(
    process.argv[3] || (existingProfile && existingProfile.globPluginsDir) || path.join(__dirname, 'global-plugins')
  ),
  specificPluginsDir: path.resolve(
    process.argv[4] ||
      (existingProfile && existingProfile.specificPluginsDir) ||
      path.join(__dirname, 'game-plugins', path.basename(initialGameRoot))
  ),
};
recomputeDerivedPaths();

function recomputeDerivedPaths() {
  state.pluginsDir = path.join(state.gameRoot, 'js', 'plugins');
  state.pluginsJsFile = path.join(state.gameRoot, 'js', 'plugins.js');
}

function fail(msg) {
  // Kept only for truly unrecoverable errors (e.g. bad CLI flags in the
  // future). Missing folders no longer go through here - see below.
  console.error('Error: ' + msg);
  process.exit(1);
}

// Checks that a candidate (gameRoot, globPluginsDir, specificPluginsDir)
// triple is usable. Never exits the process: startup logs-and-continues (so
// the GUI can still open and let you browse to fix it), and /set-paths
// reports the error and keeps serving the previous, still-valid paths.
//
// specificPluginsDir is created automatically if it doesn't exist yet - a
// brand-new game not having one is the normal case. globPluginsDir is not
// auto-created, since a missing shared folder is more likely a typo than a
// fresh setup.
function validatePaths(candidateGameRoot, candidateGlobPluginsDir, candidateSpecificPluginsDir) {
  if (!fs.existsSync(candidateGlobPluginsDir) || !fs.statSync(candidateGlobPluginsDir).isDirectory()) {
    return { ok: false, error: `global plugins folder not found: ${candidateGlobPluginsDir}` };
  }
  if (!fs.existsSync(candidateSpecificPluginsDir)) {
    try {
      fs.mkdirSync(candidateSpecificPluginsDir, { recursive: true });
    } catch (e) {
      return {
        ok: false,
        error: `could not create game-specific plugins folder: ${candidateSpecificPluginsDir} (${e.message})`,
      };
    }
  } else if (!fs.statSync(candidateSpecificPluginsDir).isDirectory()) {
    return { ok: false, error: `game-specific plugins path is not a folder: ${candidateSpecificPluginsDir}` };
  }
  const candidatePluginsJsFile = path.join(candidateGameRoot, 'js', 'plugins.js');
  if (!fs.existsSync(candidatePluginsJsFile)) {
    return {
      ok: false,
      error: `could not find js/plugins.js under game root: ${candidatePluginsJsFile} (Is "${candidateGameRoot}" the correct game root?)`,
    };
  }
  return { ok: true };
}

const startupCheck = validatePaths(state.gameRoot, state.globPluginsDir, state.specificPluginsDir);
if (!startupCheck.ok) {
  console.warn(`Warning: ${startupCheck.error}`);
  console.warn('Starting anyway - use the "Browse..." buttons in the GUI to pick valid folders.');
} else {
  saveProfile(state.gameRoot, state.globPluginsDir, state.specificPluginsDir);
}

// ---------------------------------------------------------------------------
// Sync: copy missing / outdated plugin files into js/plugins
// ---------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function listJsFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.js'));
  } catch (e) {
    return [];
  }
}

// Merges the global and game-specific source folders into one list of
// { file, dir, source }. A file present in both is taken from the
// game-specific folder (it overrides the global one for this game) and
// reported as such.
function collectSourceFiles() {
  const merged = new Map();
  for (const f of listJsFiles(state.globPluginsDir)) {
    merged.set(f, { file: f, dir: state.globPluginsDir, source: 'global' });
  }
  for (const f of listJsFiles(state.specificPluginsDir)) {
    merged.set(f, {
      file: f,
      dir: state.specificPluginsDir,
      source: merged.has(f) ? 'specific (overrides global)' : 'specific',
    });
  }
  return Array.from(merged.values());
}

function syncPlugins() {
  if (!fs.existsSync(state.pluginsDir)) fs.mkdirSync(state.pluginsDir, { recursive: true });
  const sourceFiles = collectSourceFiles();
  const report = [];
  for (const entry of sourceFiles) {
    const srcPath = path.join(entry.dir, entry.file);
    const destPath = path.join(state.pluginsDir, entry.file);
    const srcBuf = fs.readFileSync(srcPath);
    if (!fs.existsSync(destPath)) {
      fs.writeFileSync(destPath, srcBuf);
      report.push({ file: entry.file, source: entry.source, action: 'copied (new)' });
    } else {
      const destBuf = fs.readFileSync(destPath);
      if (sha256(srcBuf) !== sha256(destBuf)) {
        fs.writeFileSync(destPath, srcBuf);
        report.push({ file: entry.file, source: entry.source, action: 'overwritten (outdated)' });
      } else {
        report.push({ file: entry.file, source: entry.source, action: 'up to date' });
      }
    }
  }
  return { files: sourceFiles.map((e) => e.file), report };
}

// ---------------------------------------------------------------------------
// plugins.js reading / writing (preserves surrounding comments/formatting)
// ---------------------------------------------------------------------------

function findMatchingBracket(str, openIndex) {
  const openChar = str[openIndex];
  const closeChar = openChar === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escape = false;
  for (let i = openIndex; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === quoteChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quoteChar = c;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readPluginsJs() {
  const raw = fs.readFileSync(state.pluginsJsFile, 'utf8');
  const varIdx = raw.indexOf('$plugins');
  if (varIdx === -1) fail(`js/plugins.js does not contain a "$plugins" declaration - unexpected format.`);
  const bracketStart = raw.indexOf('[', varIdx);
  const bracketEnd = findMatchingBracket(raw, bracketStart);
  if (bracketStart === -1 || bracketEnd === -1) {
    fail(`could not parse the plugin array in js/plugins.js - unexpected format.`);
  }
  const arrayText = raw.slice(bracketStart, bracketEnd + 1);
  const prefix = raw.slice(0, bracketStart);
  const suffix = raw.slice(bracketEnd + 1);
  let plugins;
  try {
    plugins = JSON.parse(arrayText);
  } catch (e) {
    fail(`js/plugins.js array did not parse as JSON: ${e.message}`);
  }
  return { plugins, prefix, suffix };
}

function writePluginsJs(pluginsFileState) {
  const body = pluginsFileState.plugins.map((p) => JSON.stringify(p)).join(',\n');
  const content = pluginsFileState.prefix + '[\n' + body + '\n]' + pluginsFileState.suffix;
  fs.writeFileSync(state.pluginsJsFile, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Plugin header parsing (@param blocks)
// ---------------------------------------------------------------------------

function extractHeaderBlock(source) {
  // Matches a default-locale header: "/*:" NOT followed immediately by a
  // locale code like "ja"/"zh" (those look like "/*:ja"). We want "/*:"
  // followed by whitespace/newline.
  const regex = /\/\*:(?!\S)([\s\S]*?)\*\//;
  const match = regex.exec(source);
  return match ? match[1] : null;
}

function parsePluginFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const header = extractHeaderBlock(source);
  const result = { plugindesc: '', params: [] };
  if (!header) return result;

  const lines = header.split(/\r?\n/).map((l) => l.replace(/^[ \t]*\*[ \t]?/, ''));
  let currentParam = null;
  let currentTag = null;

  for (const line of lines) {
    const tagMatch = line.match(/^@(\w+)[ \t]?(.*)$/);
    if (tagMatch) {
      const tag = tagMatch[1];
      const rest = tagMatch[2];
      currentTag = tag;

      if (tag === 'plugindesc') {
        result.plugindesc = rest.trim();
      } else if (tag === 'param') {
        if (currentParam) result.params.push(currentParam);
        currentParam = {
          key: rest.trim(),
          text: '',
          desc: '',
          type: 'string',
          default: '',
          min: null,
          max: null,
          options: [],
          parent: null,
        };
      } else if (tag === 'help' || tag === 'command') {
        // Header params are done once help/command sections start.
        if (currentParam) {
          result.params.push(currentParam);
          currentParam = null;
        }
      } else if (currentParam) {
        switch (tag) {
          case 'text':
            currentParam.text = rest.trim();
            break;
          case 'desc':
            currentParam.desc = currentParam.desc ? currentParam.desc + ' ' + rest.trim() : rest.trim();
            break;
          case 'type':
            currentParam.type = rest.trim();
            break;
          case 'default':
            currentParam.default = rest;
            break;
          case 'min':
            currentParam.min = rest.trim();
            break;
          case 'max':
            currentParam.max = rest.trim();
            break;
          case 'parent':
            currentParam.parent = rest.trim();
            break;
          case 'option':
            currentParam.options.push({ label: rest.trim(), value: undefined });
            break;
          case 'value':
            if (currentParam.options.length) {
              const last = currentParam.options[currentParam.options.length - 1];
              if (last.value === undefined) last.value = rest;
            }
            break;
          default:
            break;
        }
      }
    } else if (currentTag === 'desc' && currentParam && line.trim() !== '') {
      currentParam.desc += ' ' + line.trim();
    } else if (currentTag === 'plugindesc' && !currentParam && line.trim() !== '') {
      result.plugindesc += ' ' + line.trim();
    }
  }
  if (currentParam) result.params.push(currentParam);

  // Fill in @value with the label when no explicit @value was given.
  for (const p of result.params) {
    for (const opt of p.options) {
      if (opt.value === undefined) opt.value = opt.label;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build the data payload the GUI renders from
// ---------------------------------------------------------------------------

function buildPluginData() {
  const { plugins } = readPluginsJs();
  const sourceFiles = collectSourceFiles();

  return sourceFiles.map((entry) => {
    const name = path.basename(entry.file, '.js');
    const parsed = parsePluginFile(path.join(entry.dir, entry.file));
    const existing = plugins.find((p) => p.name === name);
    const existingParams = existing ? existing.parameters || {} : {};

    const params = parsed.params.map((p) => ({
      key: p.key,
      text: p.text || p.key,
      desc: p.desc,
      type: p.type,
      min: p.min,
      max: p.max,
      options: p.options,
      parent: p.parent,
      currentValue: Object.prototype.hasOwnProperty.call(existingParams, p.key)
        ? existingParams[p.key]
        : p.default,
    }));

    return {
      name,
      source: entry.source,
      description: existing ? existing.description : parsed.plugindesc,
      status: existing ? !!existing.status : true,
      installed: !!existing,
      params,
    };
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Lists the subdirectories of `dirPath` for the in-GUI folder browser. If
// dirPath itself doesn't exist (e.g. a stale default), climbs to the nearest
// existing ancestor instead of failing outright, so Browse still opens
// somewhere useful.
function listSubdirs(dirPath) {
  let resolved = path.resolve(dirPath);
  while (!fs.existsSync(resolved)) {
    const parent = path.dirname(resolved);
    if (parent === resolved) break; // hit a filesystem root with nothing existing
    resolved = parent;
  }
  if (!fs.statSync(resolved).isDirectory()) resolved = path.dirname(resolved);

  let entries = [];
  try {
    entries = fs
      .readdirSync(resolved)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => {
        // Don't trust Dirent type flags here - on Android/Termux's FUSE-
        // backed shared storage, entries (including symlinks like
        // ~/storage/shared) often report an unknown d_type, so
        // isDirectory()/isSymbolicLink() both come back false even for
        // real directories. statSync (which follows symlinks) is the
        // only reliable check.
        try {
          return fs.statSync(path.join(resolved, name)).isDirectory();
        } catch (err) {
          return false; // broken symlink / permission denied
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    // Permission-denied subfolders etc. - just show none rather than failing.
  }

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent, // null once we're at a filesystem root
    dirs: entries,
  };
}

function renderPage(pluginData, syncReport, configError) {
  const dataJson = JSON.stringify(pluginData).replace(/</g, '\\u003c');
  const syncJson = JSON.stringify(syncReport).replace(/</g, '\\u003c');
  const profilesJson = JSON.stringify(listProfilesForGui()).replace(/</g, '\\u003c');
  const gameRoot = state.gameRoot;
  const globPluginsDir = state.globPluginsDir;
  const specificPluginsDir = state.specificPluginsDir;
  const configErrorHtml = configError
    ? `<div class="config-warning">${configError.replace(/</g, '&lt;')} &mdash; use "Browse&hellip;" below to fix it.</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Plugin Configurator</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #1b1d22; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #9aa0a6; font-size: 13px; margin-bottom: 18px; }
  .toolbar { margin-bottom: 18px; display: flex; gap: 10px; align-items: center; }
  button { background: #3a7afe; color: white; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button.secondary { background: #33363d; }
  button:hover { filter: brightness(1.1); }
  .plugin { background: #24262c; border: 1px solid #33363d; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
  .plugin-head { display: flex; justify-content: space-between; align-items: center; }
  .plugin-name { font-size: 15px; font-weight: 600; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 10px; margin-left: 8px; }
  .badge.installed { background: #2f5a34; color: #baf0c0; }
  .badge.new { background: #5a3d2f; color: #f0c8ba; }
  .badge.global { background: #2f4a5a; color: #baddf0; }
  .badge.specific { background: #4a2f5a; color: #ddbaf0; }
  .badge.override { background: #5a4a2f; color: #f0ddba; }
  .desc { color: #9aa0a6; font-size: 12px; margin: 6px 0 12px; }
  .param-row { display: grid; grid-template-columns: 180px 1fr; gap: 12px; align-items: start; margin-bottom: 10px; }
  .param-label { font-size: 13px; padding-top: 6px; }
  .param-label small { display: block; color: #9aa0a6; font-weight: normal; margin-top: 2px; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; box-sizing: border-box; background: #1b1d22; border: 1px solid #3d4048;
    color: #e6e6e6; border-radius: 5px; padding: 6px 8px; font-size: 13px; font-family: inherit;
  }
  textarea { min-height: 60px; font-family: monospace; }
  .status-line { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .save-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .save-msg { font-size: 12px; color: #7fd489; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: #2f5a34; color: #d7ffd9; padding: 10px 16px; border-radius: 6px; font-size: 13px; max-width: 360px; }
  .path-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .path-row label { width: 90px; flex-shrink: 0; font-size: 12px; color: #9aa0a6; }
  .path-row input { flex: 1; }
  #pathMsg.error { color: #ff9b9b; }
  #pathMsg.ok { color: #7fd489; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10; }
  .modal { background: #24262c; border: 1px solid #3d4048; border-radius: 8px; width: 480px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column; }
  .modal-header { padding: 12px 14px; border-bottom: 1px solid #3d4048; }
  .modal-path { font-family: monospace; font-size: 12px; color: #cfd3d8; word-break: break-all; }
  .modal-list { overflow-y: auto; flex: 1; padding: 4px 0; }
  .modal-row { padding: 8px 14px; font-size: 13px; cursor: pointer; }
  .modal-row:hover { background: #33363d; }
  .modal-row.up { color: #9aa0a6; }
  .modal-footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #3d4048; }
  .browse-err { color: #ff9b9b; font-size: 12px; flex: 1; }
  .config-warning { background: #4a2f2f; border: 1px solid #6b3d3d; color: #ffb3b3; border-radius: 6px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }
  .profiles { margin: 4px 0 18px; }
  .profiles-title { font-size: 12px; color: #9aa0a6; margin-bottom: 6px; }
  .profile-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border: 1px solid #33363d; border-radius: 6px; margin-bottom: 4px; font-size: 12px; cursor: pointer; }
  .profile-row:hover { background: #24262c; }
  .profile-row.current { border-color: #3a7afe; cursor: default; }
  .profile-name { font-weight: 600; }
  .profile-path { color: #9aa0a6; margin-left: 8px; }
</style>
</head>
<body>
<h1>Plugin Configurator</h1>
${configErrorHtml}
<div class="path-row">
  <label>Game root</label>
  <input id="gameRootInput" type="text" value="${gameRoot}">
  <button class="secondary" data-browse-target="gameRootInput">Browse&hellip;</button>
</div>
<div class="path-row">
  <label>Global plugins</label>
  <input id="globPluginsInput" type="text" value="${globPluginsDir}">
  <button class="secondary" data-browse-target="globPluginsInput">Browse&hellip;</button>
</div>
<div class="path-row">
  <label>Game-specific</label>
  <input id="specificPluginsInput" type="text" value="${specificPluginsDir}">
  <button class="secondary" data-browse-target="specificPluginsInput">Browse&hellip;</button>
</div>
<div class="toolbar">
  <button id="applyPathsBtn">Switch to these folders</button>
  <button id="syncBtn">Re-sync files</button>
  <span id="syncMsg" class="sub"></span>
</div>
<div id="pathMsg" class="sub"></div>

<div class="profiles">
  <div class="profiles-title">Known games (click to switch)</div>
  <div id="profilesList"></div>
</div>

<div id="browseModal" class="modal-backdrop" style="display:none;">
  <div class="modal">
    <div class="modal-header">
      <span id="browseCurrentPath" class="modal-path"></span>
    </div>
    <div id="browseList" class="modal-list"></div>
    <div class="modal-footer">
      <span id="browseErr" class="browse-err"></span>
      <button class="secondary" id="browseCancel">Cancel</button>
      <button id="browseSelect">Select this folder</button>
    </div>
  </div>
</div>
<div id="plugins"></div>
<script>
const DATA = ${dataJson};
const INITIAL_SYNC = ${syncJson};
const KNOWN_PROFILES = ${profilesJson};
const CURRENT_GAME_ROOT = ${JSON.stringify(gameRoot)};

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  (children || []).forEach((c) => e.appendChild(c));
  return e;
}

function renderParamInput(param) {
  const type = (param.type || 'string').toLowerCase();
  let input;
  if (type === 'boolean') {
    input = el('select', {}, [
      el('option', { value: 'true' }, [document.createTextNode('true')]),
      el('option', { value: 'false' }, [document.createTextNode('false')]),
    ]);
    input.value = String(param.currentValue) === 'false' ? 'false' : 'true';
  } else if (type === 'select' && param.options && param.options.length) {
    input = el('select', {});
    param.options.forEach((opt) => {
      const o = el('option', { value: opt.value }, [document.createTextNode(opt.label)]);
      input.appendChild(o);
    });
    input.value = param.currentValue;
  } else if (type === 'number') {
    input = el('input', { type: 'number' });
    if (param.min !== null && param.min !== undefined) input.min = param.min;
    if (param.max !== null && param.max !== undefined) input.max = param.max;
    input.value = param.currentValue;
  } else if (type === 'note' || type.indexOf('[]') !== -1 || type.indexOf('struct') !== -1 || type === 'multiline_string') {
    input = el('textarea', {});
    input.value = param.currentValue;
  } else {
    input = el('input', { type: 'text' });
    input.value = param.currentValue;
  }
  input.dataset.key = param.key;
  input.dataset.type = type;
  return input;
}

function sourceBadgeInfo(source) {
  if (source === 'global') return { cls: 'global', text: 'global' };
  if (source.indexOf('override') !== -1) return { cls: 'override', text: 'game-specific (override)' };
  return { cls: 'specific', text: 'game-specific' };
}

function renderPlugin(plugin) {
  const wrap = el('div', { class: 'plugin' });
  const head = el('div', { class: 'plugin-head' });
  const sourceBadge = sourceBadgeInfo(plugin.source);
  const nameWrap = el('div', {}, [
    el('span', { class: 'plugin-name' }, [document.createTextNode(plugin.name)]),
    el('span', { class: 'badge ' + (plugin.installed ? 'installed' : 'new') }, [
      document.createTextNode(plugin.installed ? 'in plugins.js' : 'not yet added'),
    ]),
    el('span', { class: 'badge ' + sourceBadge.cls }, [document.createTextNode(sourceBadge.text)]),
  ]);
  head.appendChild(nameWrap);
  wrap.appendChild(head);
  wrap.appendChild(el('div', { class: 'desc' }, [document.createTextNode(plugin.description || '')]));

  const statusLine = el('div', { class: 'status-line' });
  const statusBox = el('input', { type: 'checkbox' });
  statusBox.checked = !!plugin.status;
  statusLine.appendChild(statusBox);
  statusLine.appendChild(el('span', {}, [document.createTextNode('Enabled')]));
  wrap.appendChild(statusLine);

  const inputs = [];
  plugin.params.forEach((param) => {
    const row = el('div', { class: 'param-row' });
    const label = el('div', { class: 'param-label' }, [
      document.createTextNode(param.text),
      el('small', {}, [document.createTextNode(param.desc || param.key)]),
    ]);
    const input = renderParamInput(param);
    inputs.push(input);
    row.appendChild(label);
    row.appendChild(input);
    wrap.appendChild(row);
  });

  const saveRow = el('div', { class: 'save-row' });
  const saveBtn = el('button', {}, [document.createTextNode('Save ' + plugin.name)]);
  const msg = el('span', { class: 'save-msg' });
  saveBtn.addEventListener('click', async () => {
    const parameters = {};
    inputs.forEach((input) => {
      parameters[input.dataset.key] = input.value;
    });
    const payload = {
      name: plugin.name,
      status: statusBox.checked,
      description: plugin.description,
      parameters,
    };
    msg.textContent = 'Saving...';
    try {
      const resp = await fetch('/save-plugin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await resp.json();
      msg.textContent = json.ok ? 'Saved.' : 'Error: ' + json.error;
    } catch (e) {
      msg.textContent = 'Error: ' + e.message;
    }
  });
  saveRow.appendChild(saveBtn);
  saveRow.appendChild(msg);
  wrap.appendChild(saveRow);

  return wrap;
}

function renderAll() {
  const container = document.getElementById('plugins');
  container.innerHTML = '';
  DATA.forEach((plugin) => container.appendChild(renderPlugin(plugin)));
}

function showSyncReport(report) {
  const msg = document.getElementById('syncMsg');
  const changed = report.filter((r) => r.action !== 'up to date');
  msg.textContent = changed.length
    ? changed.map((r) => r.file + ' [' + r.source + ']: ' + r.action).join(' | ')
    : 'All source plugins already up to date.';
}

document.getElementById('syncBtn').addEventListener('click', async () => {
  const resp = await fetch('/sync');
  const json = await resp.json();
  if (!json.ok) {
    document.getElementById('syncMsg').textContent = json.error;
    return;
  }
  showSyncReport(json.report);
  location.reload();
});

// ---------------------------------------------------------------------------
// Known games (profiles) list
// ---------------------------------------------------------------------------

function renderProfiles() {
  const list = document.getElementById('profilesList');
  list.innerHTML = '';
  if (!KNOWN_PROFILES.length) {
    list.appendChild(
      el('div', { class: 'sub' }, [document.createTextNode('No saved games yet - switch to a game below to save one.')])
    );
    return;
  }
  KNOWN_PROFILES.forEach((p) => {
    const isCurrent = p.gameRoot === CURRENT_GAME_ROOT;
    const row = el('div', { class: 'profile-row' + (isCurrent ? ' current' : '') }, [
      el('span', {}, [
        el('span', { class: 'profile-name' }, [document.createTextNode(p.label)]),
        el('span', { class: 'profile-path' }, [document.createTextNode(p.gameRoot)]),
      ]),
      el('span', { class: 'sub' }, [document.createTextNode(isCurrent ? 'current' : 'switch')]),
    ]);
    if (!isCurrent) {
      row.addEventListener('click', () => {
        applyPaths(p.gameRoot, p.globPluginsDir, p.specificPluginsDir);
      });
    }
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Folder browser modal
// ---------------------------------------------------------------------------

const browseModal = document.getElementById('browseModal');
const browseCurrentPath = document.getElementById('browseCurrentPath');
const browseList = document.getElementById('browseList');
const browseErr = document.getElementById('browseErr');
let browseTargetInputId = null;
let browsePath = null;

async function loadBrowseDir(dirPath) {
  browseErr.textContent = '';
  try {
    const resp = await fetch('/list-dir?path=' + encodeURIComponent(dirPath));
    const json = await resp.json();
    if (!json.ok) {
      browseErr.textContent = json.error;
      return;
    }
    browsePath = json.path;
    browseCurrentPath.textContent = browsePath;
    browseList.innerHTML = '';
    if (json.parent) {
      const up = el('div', { class: 'modal-row up' }, [document.createTextNode('.. (up one level)')]);
      up.addEventListener('click', () => loadBrowseDir(json.parent));
      browseList.appendChild(up);
    }
    json.dirs.forEach((name) => {
      const row = el('div', { class: 'modal-row' }, [document.createTextNode(name)]);
      row.addEventListener('dblclick', () => loadBrowseDir(browsePath + '/' + name));
      row.addEventListener('click', () => loadBrowseDir(browsePath + '/' + name));
      browseList.appendChild(row);
    });
  } catch (e) {
    browseErr.textContent = e.message;
  }
}

document.querySelectorAll('[data-browse-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    browseTargetInputId = btn.dataset.browseTarget;
    const startPath = document.getElementById(browseTargetInputId).value;
    browseModal.style.display = 'flex';
    loadBrowseDir(startPath);
  });
});

document.getElementById('browseCancel').addEventListener('click', () => {
  browseModal.style.display = 'none';
});

document.getElementById('browseSelect').addEventListener('click', () => {
  if (browseTargetInputId && browsePath) {
    document.getElementById(browseTargetInputId).value = browsePath;
  }
  browseModal.style.display = 'none';
});

// ---------------------------------------------------------------------------
// Switch game root / global / game-specific folders without relaunching
// ---------------------------------------------------------------------------

async function applyPaths(gameRootVal, globVal, specificVal) {
  const pathMsg = document.getElementById('pathMsg');
  pathMsg.className = '';
  pathMsg.textContent = 'Switching...';
  try {
    const resp = await fetch('/set-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameRoot: gameRootVal, globPluginsDir: globVal, specificPluginsDir: specificVal }),
    });
    const json = await resp.json();
    if (json.ok) {
      location.reload();
    } else {
      pathMsg.className = 'error';
      pathMsg.textContent = json.error;
    }
  } catch (e) {
    pathMsg.className = 'error';
    pathMsg.textContent = e.message;
  }
}

document.getElementById('applyPathsBtn').addEventListener('click', () => {
  applyPaths(
    document.getElementById('gameRootInput').value,
    document.getElementById('globPluginsInput').value,
    document.getElementById('specificPluginsInput').value
  );
});

renderAll();
renderProfiles();
showSyncReport(INITIAL_SYNC);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const check = validatePaths(state.gameRoot, state.globPluginsDir, state.specificPluginsDir);
      let report = [];
      let data = [];
      if (check.ok) {
        ({ report } = syncPlugins());
        data = buildPluginData();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage(data, report, check.ok ? null : check.error));
      return;
    }

    if (req.method === 'GET' && req.url === '/sync') {
      const check = validatePaths(state.gameRoot, state.globPluginsDir, state.specificPluginsDir);
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: check.error });
        return;
      }
      const { report } = syncPlugins();
      sendJson(res, 200, { ok: true, report });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/list-dir')) {
      const reqUrl = new URL(req.url, `http://localhost`);
      const target = reqUrl.searchParams.get('path') || state.gameRoot;
      try {
        sendJson(res, 200, { ok: true, ...listSubdirs(target) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `can't open "${target}": ${e.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/set-paths') {
      const bodyText = await readBody(req);
      const body = JSON.parse(bodyText || '{}');
      const newGameRoot = path.resolve(body.gameRoot || state.gameRoot);
      const newGlobPluginsDir = path.resolve(body.globPluginsDir || state.globPluginsDir);
      const newSpecificPluginsDir = path.resolve(body.specificPluginsDir || state.specificPluginsDir);
      const check = validatePaths(newGameRoot, newGlobPluginsDir, newSpecificPluginsDir);
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: check.error });
        return;
      }
      state.gameRoot = newGameRoot;
      state.globPluginsDir = newGlobPluginsDir;
      state.specificPluginsDir = newSpecificPluginsDir;
      recomputeDerivedPaths();
      saveProfile(state.gameRoot, state.globPluginsDir, state.specificPluginsDir);
      sendJson(res, 200, {
        ok: true,
        gameRoot: state.gameRoot,
        globPluginsDir: state.globPluginsDir,
        specificPluginsDir: state.specificPluginsDir,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/save-plugin') {
      const check = validatePaths(state.gameRoot, state.globPluginsDir, state.specificPluginsDir);
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: check.error });
        return;
      }
      const bodyText = await readBody(req);
      const entry = JSON.parse(bodyText);
      if (!entry || !entry.name) {
        sendJson(res, 400, { ok: false, error: 'missing plugin name' });
        return;
      }
      const pluginsFileState = readPluginsJs();
      const idx = pluginsFileState.plugins.findIndex((p) => p.name === entry.name);
      const newEntry = {
        name: entry.name,
        status: !!entry.status,
        description: entry.description || '',
        parameters: entry.parameters || {},
      };
      if (idx === -1) pluginsFileState.plugins.push(newEntry);
      else pluginsFileState.plugins[idx] = newEntry;
      writePluginsJs(pluginsFileState);
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

function startServer(triedFallback) {
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`Plugin Configurator running at ${url}`);
    console.log(`Game root:          ${state.gameRoot}`);
    console.log(`Global plugins:     ${state.globPluginsDir}`);
    console.log(`Game-specific:      ${state.specificPluginsDir}`);
    console.log(`plugins.js:         ${state.pluginsJsFile}`);
    const openCmd =
      process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(openCmd, () => {});
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${port} is already in use, picking a free port instead...`);
    port = 0; // 0 tells the OS to assign any free port
    startServer(true);
  } else {
    throw e;
  }
});

server.on('listening', () => {
  port = server.address().port; // capture the actual port, in case it was auto-assigned
});

startServer(false);
