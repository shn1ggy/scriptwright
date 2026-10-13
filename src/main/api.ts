// The set of backend operations exposed to the renderer. Shared by Electron IPC and the
// development harness so both run exactly the same code.

import { Backend, ExportInfo } from './backend';
import { AppState, ExportScope, ExportSettings, ProjectMeta, Settings } from '../shared/types';

export function createApi(b: Backend) {
  return {
    loadSettings: () => b.loadSettings(),
    saveSettings: (s: Settings) => b.saveSettings(s),
    loadState: () => b.loadState(),
    saveState: (s: AppState) => b.saveState(s),
    setWorkspace: (dir: string) => b.setWorkspace(dir),
    getWorkspace: () => b.workspace,
    listProjects: () => b.listProjects(),
    createProject: (name: string, text?: string) => b.createProject(name, text),
    adoptLooseFile: (rel: string) => b.adoptLooseFile(rel),
    renameProject: (rel: string, name: string) => b.renameProject(rel, name),
    openProject: (rel: string) => b.openProject(rel),
    closeProject: (rel: string) => b.closeProject(rel),
    saveScript: (rel: string, text: string, expectedHash: string | null, snapshotMin?: number) => b.saveScript(rel, text, expectedHash, snapshotMin),
    restoreScript: (rel: string, text: string) => b.restoreScript(rel, text),
    readScript: (rel: string) => b.readScript(rel),
    acknowledge: (rel: string, hash: string) => b.acknowledge(rel, hash),
    saveMeta: (rel: string, meta: ProjectMeta) => b.saveMeta(rel, meta),
    readMeta: (rel: string) => b.readMeta(rel),
    saveConflictCopy: (rel: string, text: string, label: string) => b.saveConflictCopy(rel, text, label),
    writeRecovery: (id: string, rel: string, text: string) => b.writeRecovery(id, rel, text),
    clearRecovery: (id: string) => b.clearRecovery(id),
    snapshotProject: (rel: string, text: string, label: string) => b.snapshotProject(rel, text, label),
    listHistory: (rel: string) => b.listHistory(rel),
    readHistory: (rel: string, name: string) => b.readHistory(rel, name),
    readProjectFile: (rel: string, name: string) => b.readProjectFile(rel, name),
    archiveProjectFile: (rel: string, name: string) => b.archiveProjectFile(rel, name),
    backupProject: (rel: string, dest: string) => b.backupProject(rel, dest),
    importBackup: (zip: string) => b.importBackup(zip),
    importFountain: (file: string) => b.importFountain(file),
    exportPdf: (text: string, s: ExportSettings, scope: ExportScope, info: ExportInfo) => b.exportPdf(text, s, scope, info),
    exportScenePdfs: (text: string, s: ExportSettings, folder: string, info: ExportInfo) => b.exportScenePdfs(text, s, folder, info),
    saveExportCopy: (rel: string, id: string, text: string) => b.saveExportCopy(rel, id, text),
    readExportCopy: (rel: string, id: string) => b.readExportCopy(rel, id),
    deleteExportCopy: (rel: string, id: string) => b.deleteExportCopy(rel, id),
    writeFile: (file: string, data: Uint8Array | string) => b.writeFile(file, typeof data === 'string' ? data : Buffer.from(data)),
    fontsAvailable: () => b.fontsAvailable(),
    listFonts: () => b.listFonts(),
    saveDraft: (rel: string, id: string, text: string) => b.saveDraft(rel, id, text),
    readDraft: (rel: string, id: string) => b.readDraft(rel, id),
    deleteDraft: (rel: string, id: string) => b.deleteDraft(rel, id),
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiMethod = keyof Api;
