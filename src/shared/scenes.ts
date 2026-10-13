// Scene identity: matching stored scene information to the scenes in the text.
//
// While the app runs, a scene is identified by the key of its heading line, which follows
// edits and reordering. Between sessions (or after external edits) scenes are matched
// by heading and body fingerprint. Anything that cannot be matched unambiguously is kept
// as detached information for review — never attached to an unrelated scene.

import { hash32 } from './doc';
import { DetachedRecord, SceneRecord } from './types';

export interface SceneSig {
  heading: string;
  fingerprint: string;
}

export function fingerprint(bodyLines: string[]): string {
  const body = bodyLines
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  // Empty scenes have no fingerprint: they can only be matched by heading.
  return body ? hash32(body) : '';
}

export function hasInfo(r: SceneRecord): boolean {
  return !!(r.summary?.trim() || r.notes?.trim() || r.status || r.color);
}

export interface ReconcileResult {
  /** Record id for each scene, or null when it's a new scene. */
  ids: (string | null)[];
  /** Records that could not be matched. */
  unmatched: SceneRecord[];
  /** Records that matched more than one scene equally well. */
  ambiguous: SceneRecord[];
}

export function reconcile(records: SceneRecord[], scenes: SceneSig[]): ReconcileResult {
  const ids: (string | null)[] = scenes.map(() => null);
  const used = new Set<string>();
  const ambiguous = new Map<string, SceneRecord>();

  const pass = (keyOf: (x: SceneSig | SceneRecord) => string) => {
    const sceneBy = new Map<string, number[]>();
    scenes.forEach((s, i) => {
      if (ids[i]) return;
      const k = keyOf(s);
      if (!k) return;
      const arr = sceneBy.get(k) ?? [];
      arr.push(i);
      sceneBy.set(k, arr);
    });
    const recBy = new Map<string, SceneRecord[]>();
    for (const r of records) {
      if (used.has(r.id)) continue;
      const k = keyOf(r);
      if (!k) continue;
      const arr = recBy.get(k) ?? [];
      arr.push(r);
      recBy.set(k, arr);
    }
    for (const [k, recs] of recBy) {
      const sc = sceneBy.get(k);
      if (!sc) continue;
      if (recs.length === sc.length) {
        // Same number on both sides: match in order (positions are stable relative to each other).
        const sortedRecs = recs.slice().sort((a, b) => a.order - b.order);
        sortedRecs.forEach((r, n) => {
          ids[sc[n]] = r.id;
          used.add(r.id);
          ambiguous.delete(r.id);
        });
      } else if (recs.length === 1 && sc.length > 1) {
        // One record, several equally good scenes: don't guess.
        ambiguous.set(recs[0].id, recs[0]);
      } else if (recs.length > 1 && sc.length === 1) {
        for (const r of recs) ambiguous.set(r.id, r);
      }
    }
  };

  pass((x) => `${norm(x.heading)}\u0001${x.fingerprint}`);
  pass((x) => x.fingerprint);
  pass((x) => norm(x.heading));

  const unmatched = records.filter((r) => !used.has(r.id));
  return { ids, unmatched, ambiguous: [...ambiguous.values()].filter((r) => !used.has(r.id)) };
}

function norm(h: string): string {
  return h.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function detach(r: SceneRecord, reason: string): DetachedRecord {
  return { ...r, detachedAt: new Date().toISOString(), reason };
}
