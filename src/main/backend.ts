// File-system backend shared by the Electron main process and the development harness.
// Owns all disk access: workspaces, projects, atomic saves, conflict detection,
// recovery, history snapshots, backups and PDF export.

import { importFdx } from '../shared/fdx';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from '../shared/fountain';
import { paginate } from '../shared/paginate';
import {
  AppState,
  ExportScope,
  ExportSettings,
  ProjectMeta,
  Settings,
  defaultAppState,
  emptyMeta,
  mergeSettings,
} from '../shared/types';
import { RenderInfo, renderPdf, scriptFontAdvance } from './pdfexport';
import { FontFamily, listFontFamilies } from './fonts';
import { computeChanges } from '../shared/revisions';

export interface ExportInfo {
  title?: string;
  author?: string;
  extraPrefixes?: string[];
  /** Mark changes against an earlier version. */
  revision?: { text: string; sceneIds?: string[]; currentIds: Array<string | undefined>; label: string };
}
import { readZip, writeZip } from './zip';

export const META_DIR = '.scriptwright';
const META_FILE = 'project.json';

export interface ProjectEntry {
  /** Folder path relative to the workspace (or file name for loose files). */
  rel: string;
  name: string;
  /** Screenplay file name inside the folder. */
  file: string | null;
  loose: boolean;
  /** Sync conflict copies found next to the screenplay. */
  conflicts: string[];
  modified: number;
  /** In the workspace's Archive folder. */
  archived?: boolean;
}

/** Old projects are moved into this folder of the workspace (visible in Finder/Explorer too). */
export const ARCHIVE_DIR = 'Archive';

export interface OpenResult {
  text: string;
  hash: string;
  file: string;
  meta: ProjectMeta;
  metaHash: string;
  warnings: string[];
  recovery?: { text: string; savedAt: string };
  otherInstance?: { host: string; since: string };
}

export type SaveResult =
  | { ok: true; hash: string; snapshot?: string }
  | { ok: false; reason: 'conflict'; diskText: string; diskHash: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'error'; message: string };

export interface ExternalEvent {
  rel: string;
  kind: 'changed' | 'deleted' | 'restored' | 'meta' | 'conflict-copies';
  hash?: string;
  conflicts?: string[];
}

const CONFLICT_RE = /(conflicted copy|\(conflict|sync-conflict|Konflikt|\(Case Conflict\)|\s\d+\.fountain$|\.orig\.fountain$)/i;

export function sha(text: string | Buffer): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Writes a file atomically: temporary file in the same folder, fsync, rename. */
export function atomicWrite(file: string, data: string | Buffer) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.~${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can refuse a rename while another program has the target open; retry once by copying.
    try {
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw e;
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 120) || 'Untitled';
}

interface Watched {
  rel: string;
  dir: string;
  file: string;
  knownHash: string | null;
  knownMetaHash: string | null;
  exists: boolean;
  conflicts: string;
  watcher?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
}

export class Backend extends EventEmitter {
  readonly userData: string;
  readonly fontsDir: string;
  readonly instanceId = crypto.randomBytes(6).toString('hex');
  private watched = new Map<string, Watched>();
  workspace: string | null = null;

  private trash?: (file: string) => Promise<void>;

  constructor(opts: { userDataDir: string; fontsDir: string; trash?: (file: string) => Promise<void> }) {
    super();
    this.userData = opts.userDataDir;
    this.fontsDir = opts.fontsDir;
    this.trash = opts.trash;
    fs.mkdirSync(this.userData, { recursive: true });
  }

  // ---------------------------------------------------------------------------------
  // App settings and state

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /**
   * Settings live in the workspace (<workspace>/.scriptwright/settings.json) so they travel
   * with it between machines, like an Obsidian vault. The copy in the app's own folder is
   * the starting point for workspaces that have none yet. Turning this off keeps settings
   * on this computer only.
   */
  private workspaceSettingsFile(): string | null {
    if (!this.workspace) return null;
    if (this.loadState().settingsInWorkspace === false) return null;
    return path.join(this.workspace, META_DIR, 'settings.json');
  }

  loadSettings(): Settings {
    const wsFile = this.workspaceSettingsFile();
    const fromWs = wsFile ? this.readJson(wsFile) : null;
    return mergeSettings(fromWs ?? this.readJson(path.join(this.userData, 'settings.json')));
  }

  /** Where settings are stored right now (shown in Settings). */
  settingsLocation(): { inWorkspace: boolean; file: string } {
    const wsFile = this.workspaceSettingsFile();
    return { inWorkspace: !!wsFile, file: wsFile ?? path.join(this.userData, 'settings.json') };
  }

  saveSettings(s: Settings) {
    const json = JSON.stringify(s, null, 2);
    atomicWrite(path.join(this.userData, 'settings.json'), json);
    const wsFile = this.workspaceSettingsFile();
    if (wsFile) {
      try {
        fs.mkdirSync(path.dirname(wsFile), { recursive: true });
        atomicWrite(wsFile, json);
      } catch {
        // A read-only or missing workspace must not block saving the local copy.
      }
    }
  }

  loadState(): AppState {
    const d = defaultAppState();
    const s = this.readJson<AppState>(path.join(this.userData, 'state.json'));
    if (!s) return d;
    return { ...d, ...s, layout: { ...d.layout, ...(s.layout ?? {}) }, window: { ...d.window, ...(s.window ?? {}) }, sessions: s.sessions ?? {} };
  }

  saveState(s: AppState) {
    atomicWrite(path.join(this.userData, 'state.json'), JSON.stringify(s, null, 2));
    // The layout, view options and reading positions travel with the workspace too (the
    // window's size and place stay with this computer and its screen).
    const wsFile = this.workspaceStateFile(s);
    if (wsFile) {
      try {
        fs.mkdirSync(path.dirname(wsFile), { recursive: true });
        atomicWrite(wsFile, JSON.stringify({ layout: s.layout, sessions: s.sessions, lastProject: s.lastProject }, null, 2));
      } catch {
        // A read-only workspace must not block saving the local copy.
      }
    }
  }

  private workspaceStateFile(s: AppState = this.loadState()): string | null {
    if (!this.workspace || s.settingsInWorkspace === false) return null;
    return path.join(this.workspace, META_DIR, 'state.json');
  }

  /** Layout, view options and positions saved in the workspace (null when there are none). */
  loadWorkspaceState(): Pick<AppState, 'layout' | 'sessions' | 'lastProject'> | null {
    const f = this.workspaceStateFile();
    if (!f) return null;
    const s = this.readJson<Partial<AppState>>(f);
    if (!s || typeof s !== 'object') return null;
    const d = defaultAppState();
    return { layout: { ...d.layout, ...(s.layout ?? {}) }, sessions: s.sessions ?? {}, lastProject: s.lastProject };
  }

  // ---------------------------------------------------------------------------------
  // Workspace

  setWorkspace(dir: string): { ok: boolean; message?: string } {
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return { ok: false, message: 'Not a folder.' };
      this.workspace = dir;
      return { ok: true };
    } catch {
      return { ok: false, message: 'The folder is not available.' };
    }
  }

  private ws(): string {
    if (!this.workspace) throw new Error('No workspace selected');
    return this.workspace;
  }

  private resolve(rel: string): string {
    const ws = this.ws();
    const full = path.resolve(ws, rel);
    if (full !== ws && !full.startsWith(ws + path.sep)) throw new Error('Path outside the workspace');
    return full;
  }

  /** Finds the screenplay file in a project folder. */
  findScript(dir: string): { file: string | null; conflicts: string[] } {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.fountain') && !n.startsWith('.~'));
    } catch {
      return { file: null, conflicts: [] };
    }
    const conflicts = names.filter((n) => CONFLICT_RE.test(n));
    const main = names.filter((n) => !CONFLICT_RE.test(n));
    const base = path.basename(dir);
    const meta = this.readJson<ProjectMeta>(path.join(dir, META_DIR, META_FILE));
    const remembered = (meta as any)?.scriptFile as string | undefined;
    let file: string | null = null;
    if (remembered && main.includes(remembered)) file = remembered;
    else if (main.includes(base + '.fountain')) file = base + '.fountain';
    else if (main.length) file = main.sort()[0];
    else if (conflicts.length) file = null;
    // Other plain .fountain files in the folder are listed too, so nothing is hidden.
    const extras = main.filter((n) => n !== file);
    return { file, conflicts: [...conflicts, ...extras] };
  }

  listProjects(): ProjectEntry[] {
    const ws = this.ws();
    const out: ProjectEntry[] = [];
    for (const ent of fs.readdirSync(ws, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory() && ent.name === ARCHIVE_DIR) {
        for (const a of fs.readdirSync(path.join(ws, ARCHIVE_DIR), { withFileTypes: true })) {
          if (!a.isDirectory() || a.name.startsWith('.')) continue;
          const full = path.join(ws, ARCHIVE_DIR, a.name);
          const { file, conflicts } = this.findScript(full);
          if (!file && !conflicts.length && !fs.existsSync(path.join(full, META_DIR))) continue;
          let modified = 0;
          try {
            modified = fs.statSync(file ? path.join(full, file) : full).mtimeMs;
          } catch {}
          out.push({ rel: `${ARCHIVE_DIR}/${a.name}`, name: a.name, file, loose: false, conflicts, modified, archived: true });
        }
        continue;
      }
      const full = path.join(ws, ent.name);
      if (ent.isDirectory()) {
        const { file, conflicts } = this.findScript(full);
        if (!file && !conflicts.length && !fs.existsSync(path.join(full, META_DIR))) continue;
        let modified = 0;
        try {
          modified = fs.statSync(file ? path.join(full, file) : full).mtimeMs;
        } catch {}
        out.push({ rel: ent.name, name: ent.name, file, loose: false, conflicts, modified });
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.fountain')) {
        out.push({ rel: ent.name, name: ent.name.replace(/\.fountain$/i, ''), file: ent.name, loose: true, conflicts: [], modified: fs.statSync(full).mtimeMs });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out;
  }

  createProject(name: string, text = ''): ProjectEntry {
    const ws = this.ws();
    let base = safeName(name);
    let dir = path.join(ws, base);
    let n = 2;
    while (fs.existsSync(dir)) {
      dir = path.join(ws, `${safeName(name)} ${n++}`);
    }
    base = path.basename(dir);
    fs.mkdirSync(path.join(dir, META_DIR), { recursive: true });
    atomicWrite(path.join(dir, base + '.fountain'), text);
    const meta = emptyMeta(crypto.randomUUID());
    atomicWrite(path.join(dir, META_DIR, META_FILE), JSON.stringify({ ...meta, scriptFile: base + '.fountain' }, null, 2));
    return { rel: base, name: base, file: base + '.fountain', loose: false, conflicts: [], modified: Date.now() };
  }

  /** Moves a loose .fountain file into its own project folder. */
  adoptLooseFile(rel: string): ProjectEntry {
    const src = this.resolve(rel);
    const name = path.basename(rel).replace(/\.fountain$/i, '');
    const ws = this.ws();
    let dir = path.join(ws, safeName(name));
    let n = 2;
    while (fs.existsSync(dir)) dir = path.join(ws, `${safeName(name)} ${n++}`);
    fs.mkdirSync(path.join(dir, META_DIR), { recursive: true });
    const dest = path.join(dir, path.basename(src));
    fs.renameSync(src, dest);
    const meta = emptyMeta(crypto.randomUUID());
    atomicWrite(path.join(dir, META_DIR, META_FILE), JSON.stringify({ ...meta, scriptFile: path.basename(dest) }, null, 2));
    return { rel: path.basename(dir), name: path.basename(dir), file: path.basename(dest), loose: false, conflicts: [], modified: Date.now() };
  }

  renameProject(rel: string, newName: string): ProjectEntry {
    const src = this.resolve(rel);
    // Stays where it is (an archived project stays in the archive).
    const target = path.join(path.dirname(src), safeName(newName));
    if (fs.existsSync(target)) throw new Error('A project with that name already exists.');
    this.unwatch(rel);
    fs.renameSync(src, target);
    // Rename the screenplay file along with the folder when it followed the folder name.
    const oldFile = path.join(target, path.basename(src) + '.fountain');
    const newFileName = path.basename(target) + '.fountain';
    if (fs.existsSync(oldFile) && !fs.existsSync(path.join(target, newFileName))) {
      fs.renameSync(oldFile, path.join(target, newFileName));
      const metaFile = path.join(target, META_DIR, META_FILE);
      const meta = this.readJson<any>(metaFile);
      if (meta) atomicWrite(metaFile, JSON.stringify({ ...meta, scriptFile: newFileName }, null, 2));
    }
    const { file, conflicts } = this.findScript(target);
    const newRel = path.relative(this.ws(), target).split(path.sep).join('/');
    return { rel: newRel, name: path.basename(target), file, loose: false, conflicts, modified: Date.now(), archived: newRel.startsWith(ARCHIVE_DIR + '/') };
  }

  /** Moves a project into the workspace's Archive folder, or back out of it. */
  archiveProject(rel: string, archive: boolean): ProjectEntry {
    const src = this.resolve(rel);
    const name = path.basename(src);
    const destDir = archive ? path.join(this.ws(), ARCHIVE_DIR) : this.ws();
    fs.mkdirSync(destDir, { recursive: true });
    let dest = path.join(destDir, name);
    let n = 2;
    while (fs.existsSync(dest)) dest = path.join(destDir, `${name} ${n++}`);
    this.unwatch(rel);
    fs.renameSync(src, dest);
    const { file, conflicts } = this.findScript(dest);
    const newRel = path.relative(this.ws(), dest).split(path.sep).join('/');
    return { rel: newRel, name: path.basename(dest), file, loose: false, conflicts, modified: Date.now(), archived: archive };
  }

  /**
   * Deletes a project folder (or loose file) by moving it to the system trash. Without a
   * trash (development harness) it goes to the workspace's .scriptwright/deleted folder.
   */
  async deleteProject(rel: string): Promise<void> {
    const src = this.resolve(rel);
    if (src === this.ws()) throw new Error('Refusing to delete the workspace');
    this.unwatch(rel);
    if (this.trash) {
      await this.trash(src);
      return;
    }
    const bin = path.join(this.ws(), META_DIR, 'deleted');
    fs.mkdirSync(bin, { recursive: true });
    fs.renameSync(src, path.join(bin, `${stamp()} ${path.basename(src)}`));
  }

  /** Creates a new, empty workspace folder and returns its path. */
  createWorkspace(parent: string, name: string): string {
    const dir = path.join(parent, safeName(name));
    if (fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length) throw new Error('A folder with that name already exists and is not empty.');
    fs.mkdirSync(path.join(dir, META_DIR), { recursive: true });
    return dir;
  }

  // ---------------------------------------------------------------------------------
  // Projects

  openProject(rel: string): OpenResult {
    const dir = this.resolve(rel);
    const { file } = this.findScript(dir);
    if (!file) throw new Error('No screenplay file found in this project.');
    const scriptPath = path.join(dir, file);
    const text = fs.readFileSync(scriptPath, 'utf8').replace(/^﻿/, '');
    const hash = sha(text);
    const warnings: string[] = [];
    const metaPath = path.join(dir, META_DIR, META_FILE);
    let meta: ProjectMeta | null = null;
    let metaHash = '';
    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, 'utf8');
      metaHash = sha(raw);
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') throw new Error('invalid');
        meta = { ...emptyMeta(parsed.id), ...parsed };
      } catch {
        const keep = metaPath + `.damaged-${stamp()}`;
        fs.copyFileSync(metaPath, keep);
        warnings.push(`Project information was damaged and has been set aside as ${path.basename(keep)}. The screenplay opened normally.`);
      }
    }
    if (!meta) {
      meta = emptyMeta(crypto.randomUUID());
      (meta as any).scriptFile = file;
      try {
        atomicWrite(metaPath, JSON.stringify(meta, null, 2));
        metaHash = sha(fs.readFileSync(metaPath, 'utf8'));
      } catch (e: any) {
        warnings.push(`Project information could not be created: ${e.message}`);
      }
    }
    const result: OpenResult = { text, hash, file, meta, metaHash, warnings };
    const rec = this.readRecovery(meta.id);
    if (rec && rec.text !== text) result.recovery = { text: rec.text, savedAt: rec.savedAt };
    else if (rec) this.clearRecovery(meta.id);
    const lock = this.checkLock(dir);
    if (lock) result.otherInstance = lock;
    this.writeLock(dir);
    this.watch(rel, dir, file, hash, metaHash);
    return result;
  }

  closeProject(rel: string) {
    try {
      const dir = this.resolve(rel);
      const lockFile = path.join(dir, META_DIR, 'lock.json');
      const lock = this.readJson<any>(lockFile);
      if (lock && lock.instance === this.instanceId) fs.unlinkSync(lockFile);
    } catch {}
    this.unwatch(rel);
  }

  private checkLock(dir: string): { host: string; since: string } | null {
    const lock = this.readJson<any>(path.join(dir, META_DIR, 'lock.json'));
    if (!lock || lock.instance === this.instanceId) return null;
    const age = Date.now() - Date.parse(lock.heartbeat ?? 0);
    if (age > 3 * 60 * 1000) return null;
    if (lock.host === os.hostname() && typeof lock.pid === 'number' && !processAlive(lock.pid)) return null;
    return { host: lock.host === os.hostname() ? 'another window on this computer' : lock.host, since: lock.since };
  }

  private writeLock(dir: string) {
    try {
      const file = path.join(dir, META_DIR, 'lock.json');
      const existing = this.readJson<any>(file);
      const since = existing && existing.instance === this.instanceId ? existing.since : new Date().toISOString();
      atomicWrite(file, JSON.stringify({ host: os.hostname(), instance: this.instanceId, pid: process.pid, since, heartbeat: new Date().toISOString() }));
    } catch {}
  }

  /** Saves the screenplay only if the file on disk is still the version we know. */
  saveScript(rel: string, text: string, expectedHash: string | null, snapshotIntervalMin = 10): SaveResult {
    let w = this.watched.get(rel);
    try {
      const dir = this.resolve(rel);
      const file = w?.file ?? this.findScript(dir).file;
      if (!file) return { ok: false, reason: 'missing' };
      const scriptPath = path.join(dir, file);
      if (!fs.existsSync(dir)) return { ok: false, reason: 'missing' };
      if (fs.existsSync(scriptPath)) {
        const disk = fs.readFileSync(scriptPath, 'utf8').replace(/^﻿/, '');
        const diskHash = sha(disk);
        if (expectedHash && diskHash !== expectedHash && diskHash !== sha(text)) {
          return { ok: false, reason: 'conflict', diskText: disk, diskHash };
        }
      } else if (expectedHash) {
        // The file vanished (deleted or renamed outside the app).
        return { ok: false, reason: 'missing' };
      }
      atomicWrite(scriptPath, text);
      const hash = sha(text);
      if (w) {
        w.knownHash = hash;
        w.exists = true;
      }
      // Only an open project holds a lock: a last save while the window closes must not leave one behind.
      if (this.watched.has(rel)) this.writeLock(dir);
      const snapshot = this.maybeSnapshot(dir, text, snapshotIntervalMin);
      return { ok: true, hash, snapshot };
    } catch (e: any) {
      return { ok: false, reason: 'error', message: e?.message ?? String(e) };
    }
  }

  /** Writes the screenplay again after it went missing (explicit user choice). */
  restoreScript(rel: string, text: string): SaveResult {
    const w = this.watched.get(rel);
    try {
      const dir = this.resolve(rel);
      fs.mkdirSync(dir, { recursive: true });
      const file = w?.file ?? path.basename(dir) + '.fountain';
      atomicWrite(path.join(dir, file), text);
      const hash = sha(text);
      if (w) {
        w.knownHash = hash;
        w.exists = true;
      }
      return { ok: true, hash };
    } catch (e: any) {
      return { ok: false, reason: 'error', message: e?.message ?? String(e) };
    }
  }

  readScript(rel: string): { text: string; hash: string } | null {
    try {
      const dir = this.resolve(rel);
      const file = this.watched.get(rel)?.file ?? this.findScript(dir).file;
      if (!file) return null;
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '');
      return { text, hash: sha(text) };
    } catch {
      return null;
    }
  }

  /** Marks a disk version as known (after the user reloads or resolves a conflict). */
  acknowledge(rel: string, hash: string) {
    const w = this.watched.get(rel);
    if (w) w.knownHash = hash;
  }

  saveMeta(rel: string, meta: ProjectMeta): { ok: boolean; hash?: string; message?: string; preservedExternal?: string } {
    try {
      const dir = this.resolve(rel);
      const metaPath = path.join(dir, META_DIR, META_FILE);
      const w = this.watched.get(rel);
      let preservedExternal: string | undefined;
      if (fs.existsSync(metaPath) && w?.knownMetaHash) {
        const raw = fs.readFileSync(metaPath, 'utf8');
        if (sha(raw) !== w.knownMetaHash) {
          // Someone else changed project information: keep their version beside ours.
          const keep = path.join(dir, META_DIR, 'conflicts', `project-${stamp()}.json`);
          fs.mkdirSync(path.dirname(keep), { recursive: true });
          fs.writeFileSync(keep, raw);
          preservedExternal = path.relative(dir, keep);
        }
      }
      const data = JSON.stringify({ ...meta, scriptFile: w?.file ?? (meta as any).scriptFile }, null, 2);
      atomicWrite(metaPath, data);
      const hash = sha(data);
      if (w) w.knownMetaHash = hash;
      return { ok: true, hash, preservedExternal };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  /** Saves a copy of a version next to the project's history so nothing is lost. */
  saveConflictCopy(rel: string, text: string, label: string): string {
    const dir = this.resolve(rel);
    const file = path.join(dir, META_DIR, 'conflicts', `${stamp()} ${safeName(label)}.fountain`);
    atomicWrite(file, text);
    return path.relative(dir, file);
  }

  // ---------------------------------------------------------------------------------
  // Recovery (outside the project, so it survives a failing disk or sync folder)

  private recoveryFile(id: string) {
    return path.join(this.userData, 'recovery', `${id.replace(/[^\w-]/g, '')}.json`);
  }

  writeRecovery(id: string, rel: string, text: string) {
    atomicWrite(this.recoveryFile(id), JSON.stringify({ text, rel, workspace: this.workspace, savedAt: new Date().toISOString() }));
  }

  readRecovery(id: string): { text: string; savedAt: string } | null {
    return this.readJson(this.recoveryFile(id));
  }

  clearRecovery(id: string) {
    try {
      fs.unlinkSync(this.recoveryFile(id));
    } catch {}
  }

  // ---------------------------------------------------------------------------------
  // History snapshots
  //
  // Retention: every snapshot from the last 24 hours is kept; older ones are thinned to
  // one per day for 30 days; snapshots older than 30 days are removed. Snapshots are
  // taken at most every `snapshotIntervalMin` minutes while writing, and before any
  // restore or conflict resolution. Named drafts (later stage) are never removed.

  private historyDir(dir: string) {
    return path.join(dir, META_DIR, 'history');
  }

  private maybeSnapshot(dir: string, text: string, intervalMin: number): string | undefined {
    const hdir = this.historyDir(dir);
    let files: string[] = [];
    try {
      files = fs.readdirSync(hdir).filter((f) => f.endsWith('.fountain')).sort();
    } catch {}
    const last = files[files.length - 1];
    if (last) {
      const t = this.snapshotTime(last);
      if (t && Date.now() - t < intervalMin * 60 * 1000) return undefined;
      try {
        if (sha(fs.readFileSync(path.join(hdir, last), 'utf8')) === sha(text)) return undefined;
      } catch {}
    }
    return this.snapshot(dir, text);
  }

  snapshot(dir: string, text: string, label = 'auto'): string {
    const hdir = this.historyDir(dir);
    const name = `${stamp()} ${safeName(label)}.fountain`;
    atomicWrite(path.join(hdir, name), text);
    this.pruneHistory(hdir);
    return name;
  }

  snapshotProject(rel: string, text: string, label: string): string {
    return this.snapshot(this.resolve(rel), text, label);
  }

  private snapshotTime(name: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  pruneHistory(hdir: string, now = Date.now()) {
    let files: string[];
    try {
      files = fs.readdirSync(hdir).filter((f) => f.endsWith('.fountain')).sort();
    } catch {
      return;
    }
    const keepDays = new Set<string>();
    // Iterate newest first so the latest snapshot of each day is the one kept.
    for (const f of files.slice().reverse()) {
      const t = this.snapshotTime(f);
      if (!t) continue;
      const age = now - t;
      if (age < 24 * 3600 * 1000) continue;
      if (/ auto\.fountain$/.test(f) === false) continue; // labelled safety copies are kept
      const day = f.slice(0, 10);
      if (age > 30 * 24 * 3600 * 1000 || keepDays.has(day)) {
        try {
          fs.unlinkSync(path.join(hdir, f));
        } catch {}
      } else keepDays.add(day);
    }
  }

  listHistory(rel: string): Array<{ name: string; time: number; size: number }> {
    const hdir = this.historyDir(this.resolve(rel));
    try {
      return fs
        .readdirSync(hdir)
        .filter((f) => f.endsWith('.fountain'))
        .map((f) => ({ name: f, time: this.snapshotTime(f) ?? 0, size: fs.statSync(path.join(hdir, f)).size }))
        .sort((a, b) => b.time - a.time);
    } catch {
      return [];
    }
  }

  readHistory(rel: string, name: string): string {
    const hdir = this.historyDir(this.resolve(rel));
    const file = path.join(hdir, path.basename(name));
    return fs.readFileSync(file, 'utf8');
  }

  // ---------------------------------------------------------------------------------
  // Named drafts (kept until the writer deletes them)

  private draftFile(rel: string, id: string) {
    return path.join(this.resolve(rel), META_DIR, 'drafts', `${id.replace(/[^\w-]/g, '')}.fountain`);
  }

  saveDraft(rel: string, id: string, text: string) {
    atomicWrite(this.draftFile(rel, id), text);
  }

  readDraft(rel: string, id: string): string {
    return fs.readFileSync(this.draftFile(rel, id), 'utf8');
  }

  deleteDraft(rel: string, id: string) {
    const f = this.draftFile(rel, id);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // ---------------------------------------------------------------------------------
  // Watching for external changes (fs.watch plus polling for synced and network folders)

  private watch(rel: string, dir: string, file: string, hash: string, metaHash: string) {
    this.unwatch(rel);
    const w: Watched = { rel, dir, file, knownHash: hash, knownMetaHash: metaHash || null, exists: true, conflicts: '' };
    w.conflicts = this.findScript(dir).conflicts.join('\n');
    this.watched.set(rel, w);
    const check = () => {
      clearTimeout(w.debounce);
      w.debounce = setTimeout(() => this.check(w), 250);
    };
    try {
      w.watcher = fs.watch(dir, { persistent: false }, check);
      w.watcher.on('error', () => {});
    } catch {}
    w.timer = setInterval(() => this.check(w), 2000);
    (w.timer as any).unref?.();
  }

  private check(w: Watched) {
    if (!this.watched.has(w.rel)) return;
    const scriptPath = path.join(w.dir, w.file);
    let exists = false;
    let text = '';
    try {
      text = fs.readFileSync(scriptPath, 'utf8').replace(/^﻿/, '');
      exists = true;
    } catch {}
    if (!exists && w.exists) {
      w.exists = false;
      this.emit('external', { rel: w.rel, kind: 'deleted' } as ExternalEvent);
    } else if (exists) {
      const h = sha(text);
      if (!w.exists) {
        w.exists = true;
        this.emit('external', { rel: w.rel, kind: 'restored', hash: h } as ExternalEvent);
      }
      if (h !== w.knownHash) {
        // Announce once; the renderer decides whether to reload or keep both versions.
        w.knownHash = h;
        this.emit('external', { rel: w.rel, kind: 'changed', hash: h } as ExternalEvent);
      }
    }
    try {
      const raw = fs.readFileSync(path.join(w.dir, META_DIR, META_FILE), 'utf8');
      const mh = sha(raw);
      if (w.knownMetaHash && mh !== w.knownMetaHash) {
        this.emit('external', { rel: w.rel, kind: 'meta', hash: mh } as ExternalEvent);
        w.knownMetaHash = mh;
      }
    } catch {}
    const conflicts = this.findScript(w.dir).conflicts;
    if (conflicts.join('\n') !== w.conflicts) {
      w.conflicts = conflicts.join('\n');
      this.emit('external', { rel: w.rel, kind: 'conflict-copies', conflicts } as ExternalEvent);
    }
  }

  readMeta(rel: string): { meta: ProjectMeta; hash: string } | null {
    try {
      const raw = fs.readFileSync(path.join(this.resolve(rel), META_DIR, META_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      return { meta: { ...emptyMeta(parsed.id), ...parsed }, hash: sha(raw) };
    } catch {
      return null;
    }
  }

  unwatch(rel: string) {
    const w = this.watched.get(rel);
    if (!w) return;
    w.watcher?.close();
    clearInterval(w.timer);
    clearTimeout(w.debounce);
    this.watched.delete(rel);
  }

  dispose() {
    for (const rel of [...this.watched.keys()]) this.closeProject(rel);
  }

  /** Reads a conflict copy or extra .fountain file in the project folder. */
  readProjectFile(rel: string, name: string): string {
    const dir = this.resolve(rel);
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) throw new Error('Invalid file');
    return fs.readFileSync(file, 'utf8');
  }

  /** Moves a reviewed conflict copy into the project's conflicts folder. */
  archiveProjectFile(rel: string, name: string): string {
    const dir = this.resolve(rel);
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) throw new Error('Invalid file');
    const dest = path.join(dir, META_DIR, 'conflicts', `${stamp()} ${path.basename(name)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    return path.relative(dir, dest);
  }

  // ---------------------------------------------------------------------------------
  // Backup and transfer

  backupProject(rel: string, destFile: string): { files: number; bytes: number } {
    const dir = this.resolve(rel);
    const entries: Array<{ name: string; data: Buffer; mtime: Date }> = [];
    const base = path.basename(dir);
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.name === 'lock.json' || ent.name.startsWith('.~')) continue;
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) entries.push({ name: path.join(base, path.relative(dir, full)).split(path.sep).join('/'), data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
      }
    };
    walk(dir);
    const zip = writeZip(entries);
    atomicWrite(destFile, zip);
    return { files: entries.length, bytes: zip.length };
  }

  importBackup(zipFile: string): ProjectEntry {
    const entries = readZip(fs.readFileSync(zipFile));
    if (!entries.length) throw new Error('The backup is empty.');
    const top = entries[0].name.split('/')[0];
    const single = entries.every((e) => e.name.split('/')[0] === top && e.name.includes('/'));
    const projectName = single ? top : path.basename(zipFile).replace(/\.zip$/i, '');
    const ws = this.ws();
    let dir = path.join(ws, safeName(projectName));
    let n = 2;
    while (fs.existsSync(dir)) dir = path.join(ws, `${safeName(projectName)} (imported ${n++})`);
    for (const e of entries) {
      const relName = single ? e.name.slice(top.length + 1) : e.name;
      const target = path.resolve(dir, relName);
      if (!target.startsWith(dir + path.sep)) continue; // never write outside the project
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
    }
    // Imported copies get a new identity so they don't share recovery with the original.
    const metaFile = path.join(dir, META_DIR, META_FILE);
    const meta = this.readJson<any>(metaFile);
    if (meta) atomicWrite(metaFile, JSON.stringify({ ...meta, id: crypto.randomUUID(), importedFrom: meta.id }, null, 2));
    const { file, conflicts } = this.findScript(dir);
    return { rel: path.basename(dir), name: path.basename(dir), file, loose: false, conflicts, modified: Date.now() };
  }

  /** Imports a Fountain or Final Draft (.fdx) file into a new project. */
  importFountain(srcFile: string): ProjectEntry {
    const raw = fs.readFileSync(srcFile, 'utf8').replace(/^﻿/, '');
    const text = /\.fdx$/i.test(srcFile) ? importFdx(raw) : raw;
    return this.createProject(path.basename(srcFile).replace(/\.(fountain|txt|spmd|fdx)$/i, ''), text);
  }

  // ---------------------------------------------------------------------------------
  // Export

  private renderInfo(extra: { title?: string; author?: string } = {}): RenderInfo {
    return { ...extra, fontsDir: this.fontsDir, families: () => this.fontFamilies() };
  }

  fontFamilies(): FontFamily[] {
    return listFontFamilies(path.join(this.userData, 'font-cache.json'));
  }

  /** Font families for the font menus (without file details). */
  listFonts(): Array<{ family: string; mono: boolean; advance: number }> {
    return this.fontFamilies().map((f) => ({ family: f.family, mono: f.mono, advance: f.advance }));
  }

  exportPdf(text: string, settings: ExportSettings, scope: ExportScope, info: ExportInfo) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const p = parse(lines, { extraPrefixes: info.extraPrefixes });
    const ri = this.renderInfo({ title: info.title, author: info.author });
    const rev = this.revisionMarks(lines, p, settings, info);
    if (rev) ri.revisionLabel = info.revision!.label;
    const result = paginate(lines, p, settings, scope, scriptFontAdvance(settings, ri), rev?.marks);
    const out = renderPdf(result, settings, ri);
    return {
      pdf: out.pdf,
      pages: result.bodyPageCount,
      warnings: out.warnings,
      fontUsed: out.fontUsed,
      capacity: result.capacity,
      revision: rev ? { ...rev.stats, changedPages: result.pages.filter((pg) => pg.changed).length } : null,
    };
  }

  private revisionMarks(lines: string[], p: ReturnType<typeof parse>, s: ExportSettings, info: ExportInfo) {
    const r = info.revision;
    if (!r) return null;
    const ch = computeChanges(
      lines,
      p,
      r.currentIds,
      r.text,
      r.sceneIds,
      { ignoreOrder: s.revIgnoreOrder, ignoreSceneNumbers: s.revIgnoreSceneNumbers, markDeletions: s.revMarkDeletions, markMoved: s.revMarkMoved },
      info.extraPrefixes,
    );
    return { marks: { chars: ch.chars, marked: ch.marked, changedPagesOnly: s.revChangedPagesOnly }, stats: ch.stats };
  }

  // Copies of the screenplay saved with every export -----------------------------------

  private exportCopyFile(rel: string, id: string) {
    return path.join(this.resolve(rel), META_DIR, 'exports', `${id.replace(/[^\w-]/g, '')}.fountain`);
  }

  saveExportCopy(rel: string, id: string, text: string) {
    atomicWrite(this.exportCopyFile(rel, id), text);
  }

  readExportCopy(rel: string, id: string): string {
    return fs.readFileSync(this.exportCopyFile(rel, id), 'utf8');
  }

  deleteExportCopy(rel: string, id: string) {
    const f = this.exportCopyFile(rel, id);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  /** Separate PDFs for each scene into a folder. */
  exportScenePdfs(text: string, settings: ExportSettings, folder: string, info: ExportInfo) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const p = parse(lines, { extraPrefixes: info.extraPrefixes });
    fs.mkdirSync(folder, { recursive: true });
    const ri = this.renderInfo({ title: info.title });
    const adv = scriptFontAdvance(settings, ri);
    const rev = this.revisionMarks(lines, p, settings, info);
    if (rev) ri.revisionLabel = info.revision!.label;
    const written: string[] = [];
    p.scenes.forEach((sc, idx) => {
      const r = paginate(lines, p, { ...settings, titlePage: false }, { kind: 'scenes', sceneLines: [sc.line] }, adv, rev ? { ...rev.marks, changedPagesOnly: false } : undefined);
      const out = renderPdf(r, settings, ri);
      const name = `${String(idx + 1).padStart(3, '0')} ${safeName(sc.heading).slice(0, 60)}.pdf`;
      atomicWrite(path.join(folder, name), out.pdf);
      written.push(name);
    });
    return { files: written };
  }

  writeFile(file: string, data: Buffer | string) {
    atomicWrite(file, data);
  }

  /** Reads a small text file the user chose (e.g. exported shortcuts). */
  readTextFile(file: string): string {
    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) throw new Error('The file is too large.');
    return fs.readFileSync(file, 'utf8');
  }

  /** The bundled Courier Prime faces, for the editor (loaded as data, not through file URLs). */
  scriptFontFaces(): Array<{ weight: string; style: string; data: Uint8Array }> {
    const faces: Array<[string, string, string]> = [
      ['CourierPrime-Regular.ttf', '400', 'normal'],
      ['CourierPrime-Bold.ttf', '700', 'normal'],
      ['CourierPrime-Italic.ttf', '400', 'italic'],
      ['CourierPrime-BoldItalic.ttf', '700', 'italic'],
    ];
    const out: Array<{ weight: string; style: string; data: Uint8Array }> = [];
    for (const [f, weight, style] of faces) {
      try {
        out.push({ weight, style, data: new Uint8Array(fs.readFileSync(path.join(this.fontsDir, f))) });
      } catch {
        // Missing faces fall back to the stylesheet (or Courier).
      }
    }
    return out;
  }

  fontsAvailable(): boolean {
    return ['CourierPrime-Regular.ttf', 'CourierPrime-Bold.ttf', 'CourierPrime-Italic.ttf', 'CourierPrime-BoldItalic.ttf'].every((f) =>
      fs.existsSync(path.join(this.fontsDir, f)),
    );
  }
}

/** Whether a process with this id still runs here (a lock left by a closed or crashed window is stale). */
function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}
