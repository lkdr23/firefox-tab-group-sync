// The cloud holds one document per writer, containing only fields that writer
// changed. Lamport revisions make merges independent of arrival order. Deletion
// is terminal for an identity; undo/reopening a tab receives a fresh identity.
export const SCHEMA = 1;
export const COLORS = ['blue', 'red', 'green', 'orange', 'yellow', 'purple', 'pink', 'cyan', 'grey'];
export const clone = value => JSON.parse(JSON.stringify(value));
export const validId = (id, kind) => typeof id === 'string' && new RegExp(`^${kind}_[A-Za-z0-9_-]{1,80}$`).test(id);
const validDevice = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
export const validRevision = r => Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && r[0] >= 0 && validDevice(r[1]);
export function compareRevision(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function syncUrl(url) {
  try {
    const parsed = new URL(url);
    // Keep the exact URL: trailing slashes, fragments and query strings matter.
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch (_) { return null; }
}
export function emptyDocument(device, epoch) {
  return { schema: SCHEMA, device, epoch, clock: epoch[0], records: {} };
}
export function validateDocument(doc) {
  if (!doc || doc.schema !== SCHEMA || !validDevice(doc.device) || !validRevision(doc.epoch) ||
      !Number.isSafeInteger(doc.clock) || doc.clock < doc.epoch[0] || !doc.records ||
      Array.isArray(doc.records) || typeof doc.records !== 'object' || Object.keys(doc.records).length > 10000) {
    throw new Error('Unsupported or invalid sync document. Local tabs have been kept.');
  }
  for (const [id, fields] of Object.entries(doc.records)) {
    const tab = validId(id, 't');
    if ((!tab && !validId(id, 'g')) || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid sync identity.');
    for (const [name, field] of Object.entries(fields)) {
      if (!field || !validRevision(field.r) || field.r[0] > doc.clock || field.r[1] !== doc.device) throw new Error('Invalid sync revision.');
      const v = field.v;
      let valid = false;
      if (tab) {
        if (name === 'url') valid = typeof v === 'string' && v.length <= 65536 && syncUrl(v) === v;
        if (name === 'pinned') valid = typeof v === 'boolean';
        if (name === 'deleted') valid = v === true;
        if (name === 'placement') valid = v && validId(v.window, 'w') && (v.group === null || validId(v.group, 'g')) && Number.isSafeInteger(v.index) && v.index >= 0 && v.index <= 100000;
      } else {
        if (name === 'title') valid = typeof v === 'string' && v.length <= 256;
        if (name === 'color') valid = COLORS.includes(v);
        if (name === 'collapsed') valid = typeof v === 'boolean';
      }
      if (!valid) throw new Error(`Invalid synced ${name}. Local tabs have been kept.`);
    }
  }
  return doc;
}
export function mergeDocuments(documents) {
  documents.forEach(validateDocument);
  let epoch = null;
  for (const doc of documents) if (compareRevision(doc.epoch, epoch) > 0) epoch = doc.epoch;
  const model = { epoch, clock: epoch ? epoch[0] : 0, records: {} };
  for (const doc of documents) {
    model.clock = Math.max(model.clock, doc.clock);
    if (compareRevision(doc.epoch, epoch) !== 0) continue;
    for (const [id, fields] of Object.entries(doc.records)) {
      const target = model.records[id] || (model.records[id] = {});
      for (const [name, field] of Object.entries(fields)) {
        if (!target[name] || compareRevision(field.r, target[name].r) > 0) target[name] = clone(field);
      }
    }
  }
  return model;
}
export function materialize(model) {
  const snapshot = { tabs: {}, groups: {} };
  for (const [id, fields] of Object.entries(model.records)) {
    const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, clone(field.v)]));
    if (validId(id, 'g')) {
      snapshot.groups[id] = { title: values.title || '', color: values.color || 'grey', collapsed: !!values.collapsed };
    } else if (!values.deleted && values.url && values.placement) {
      snapshot.tabs[id] = { url: values.url, pinned: !!values.pinned, placement: values.placement };
      if (values.pinned || !snapshot.groups[values.placement.group] && !model.records[values.placement.group]) snapshot.tabs[id].placement.group = null;
    }
  }
  // A group can only belong to one window. Concurrent moves converge on the
  // window of its most recently moved member, including a deterministic tie.
  const groupWindows = new Map();
  for (const [id, tab] of Object.entries(snapshot.tabs)) {
    if (!tab.placement.group) continue;
    const prior = groupWindows.get(tab.placement.group);
    const revision = model.records[id].placement.r;
    if (!prior || compareRevision(revision, prior.revision) > 0 || (compareRevision(revision, prior.revision) === 0 && id > prior.id)) {
      groupWindows.set(tab.placement.group, { window: tab.placement.window, revision, id });
    }
  }
  for (const tab of Object.values(snapshot.tabs)) if (tab.placement.group) tab.placement.window = groupWindows.get(tab.placement.group).window;
  return snapshot;
}
export function recordChanges(doc, previous, current, removed = [], clock = doc.clock) {
  const next = clone(doc);
  next.clock = Math.max(next.clock, clock) + 1;
  const revision = [next.clock, next.device];
  let changed = false;
  const write = (id, name, value) => {
    const fields = next.records[id] || (next.records[id] = {});
    fields[name] = { v: clone(value), r: revision };
    changed = true;
  };
  for (const kind of ['tabs', 'groups']) {
    for (const [id, values] of Object.entries(current[kind])) {
      for (const [name, value] of Object.entries(values)) {
        if (!same(previous[kind][id]?.[name], value)) write(id, name, value);
      }
    }
  }
  // Absence in a startup snapshot is never a deletion: Firefox might still be
  // restoring windows. Only observed tab-close/unsupported-navigation events
  // generate tombstones.
  for (const id of new Set(removed)) if (validId(id, 't')) write(id, 'deleted', true);
  if (!changed) next.clock = doc.clock;
  return { document: next, changed };
}
export function orderedTabs(snapshot, window) {
  const entries = Object.entries(snapshot.tabs).filter(([, t]) => t.placement.window === window);
  const groupIndex = new Map();
  for (const [, tab] of entries) if (tab.placement.group) groupIndex.set(tab.placement.group, Math.min(groupIndex.get(tab.placement.group) ?? Infinity, tab.placement.index));
  return entries.sort(([a, x], [b, y]) => {
    if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
    const xBlock = groupIndex.get(x.placement.group) ?? x.placement.index;
    const yBlock = groupIndex.get(y.placement.group) ?? y.placement.index;
    return xBlock - yBlock || (x.placement.group || a).localeCompare(y.placement.group || b) || x.placement.index - y.placement.index || a.localeCompare(b);
  });
}
