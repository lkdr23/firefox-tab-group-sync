import { COLORS, clone, orderedTabs, same, syncUrl, validId } from './profile-model.js';

const TAB_TAG = 'profile-sync-tab';
const WINDOW_TAG = 'profile-sync-window';
const GROUP_TAG = 'profile-sync-group';
export const NATIVE_IDS_KEY = 'profile_sync_native_ids';
const fresh = kind => `${kind}_${crypto.randomUUID()}`;

export class ProfileBrowser {
  constructor(api) {
    this.api = api;
    this.tabIds = new Map(); // native ID -> persistent identity
    this.windowIds = new Map();
    this.groupIds = new Map();
    this.closedWindows = new Set();
    this.ownRemovals = new Set();
  }
  async capture(model = { records: {} }) {
    const windows = (await this.api.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter(w => !w.incognito);
    const groups = await this.api.tabGroups.query({});
    const snapshot = { tabs: {}, groups: {} };
    const nativeTabs = new Map();
    const nativeWindows = new Map();
    const nativeGroups = new Map();
    const excluded = [];
    const usedTabs = new Set(), usedWindows = new Set(), usedGroups = new Set();
    for (const window of windows) {
      let wid = await this.api.sessions.getWindowValue(window.id, WINDOW_TAG);
      if (!validId(wid, 'w') || usedWindows.has(wid)) wid = fresh('w');
      usedWindows.add(wid);
      this.windowIds.set(window.id, wid);
      nativeWindows.set(wid, window);
      if (await this.api.sessions.getWindowValue(window.id, WINDOW_TAG) !== wid) await this.api.sessions.setWindowValue(window.id, WINDOW_TAG, wid);
      const tabs = window.tabs || [];
      const tags = new Map();
      for (const tab of tabs) {
        if (tab.incognito) continue;
        const stored = await this.api.sessions.getTabValue(tab.id, TAB_TAG);
        let tid = stored;
        if (!validId(tid, 't') || usedTabs.has(tid) || (model.records[tid]?.deleted && !model.retainIds?.has(tid))) tid = fresh('t');
        usedTabs.add(tid);
        this.tabIds.set(tab.id, tid);
        if (stored !== tid) await this.api.sessions.setTabValue(tab.id, TAB_TAG, tid);
        tags.set(tab.id, { id: tid, group: await this.api.sessions.getTabValue(tab.id, GROUP_TAG) });
      }
      for (const group of groups.filter(g => g.windowId === window.id)) {
        const members = tabs.filter(t => t.groupId === group.id);
        let gid = this.groupIds.get(group.id);
        if (!validId(gid, 'g') || usedGroups.has(gid)) {
          gid = members.map(t => tags.get(t.id)?.group).find(id => validId(id, 'g') && !usedGroups.has(id)) || fresh('g');
        }
        usedGroups.add(gid);
        this.groupIds.set(group.id, gid);
        nativeGroups.set(gid, group);
        snapshot.groups[gid] = { title: (group.title || '').slice(0, 256), color: COLORS.includes(group.color) ? group.color : 'grey', collapsed: !!group.collapsed };
      }
      for (const tab of tabs) {
        const tag = tags.get(tab.id);
        if (!tag) continue;
        const group = tab.pinned ? null : this.groupIds.get(tab.groupId) || null;
        if (tag.group !== group) await this.api.sessions.setTabValue(tab.id, GROUP_TAG, group);
        const url = syncUrl(tab.pendingUrl || tab.url);
        if (!url) { excluded.push(tag.id); continue; }
        snapshot.tabs[tag.id] = { url, pinned: !!tab.pinned, placement: { window: wid, group, index: tab.index } };
        nativeTabs.set(tag.id, tab);
      }
    }
    // Drop native group IDs which are no longer present (Firefox may reuse IDs).
    const liveGroups = new Set(groups.map(g => g.id));
    for (const id of this.groupIds.keys()) if (!liveGroups.has(id)) this.groupIds.delete(id);
    await this.persistNativeMaps();
    return { snapshot, nativeTabs, nativeWindows, nativeGroups, excluded };
  }
  async persistNativeMaps() {
    // Survives MV3 event-page suspension, but is cleared by Firefox on browser
    // restart. A removed tab is already gone when it wakes the background page;
    // its last native-to-logical mapping must still be available then.
    if (this.api.storage.session) await this.api.storage.session.set({ [NATIVE_IDS_KEY]: {
      tabs: [...this.tabIds], windows: [...this.windowIds], groups: [...this.groupIds]
    } });
  }
  closedTab(nativeId, info) {
    if (this.ownRemovals.delete(nativeId)) { this.tabIds.delete(nativeId); return null; }
    const id = this.tabIds.get(nativeId);
    this.tabIds.delete(nativeId);
    if (info.isWindowClosing) {
      const window = this.windowIds.get(info.windowId);
      if (window) this.closedWindows.add(window);
      return null;
    }
    return id || null;
  }
  async removeTabs(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    list.forEach(id => this.ownRemovals.add(id));
    try { await this.api.tabs.remove(ids); }
    catch (error) { list.forEach(id => this.ownRemovals.delete(id)); throw error; }
  }
  async apply(snapshot, model, { replace = false } = {}) {
    const api = this.api;
    const before = await this.capture();
    // Do not recreate windows while Firefox is shutting down.
    if (!before.nativeWindows.size) return before;
    const nativeTabs = before.nativeTabs;
    const windows = before.nativeWindows;
    const bootstrap = new Map();
    const desiredWindows = new Set(Object.values(snapshot.tabs).map(t => t.placement.window));
    if (replace) for (const wid of desiredWindows) this.closedWindows.delete(wid);
    const replaceable = [...windows.values()];
    for (const wid of desiredWindows) {
      if (windows.has(wid) || (!replace && this.closedWindows.has(wid))) continue;
      // Initial replacement reuses ordinary windows instead of opening an extra
      // window for every existing session. Internal/local tabs remain untouched.
      let window = replace ? replaceable.shift() : null;
      if (window) {
        for (const [id, existing] of windows) if (existing.id === window.id) windows.delete(id);
      } else {
        window = await api.windows.create({ focused: false });
        for (const tab of window.tabs || []) bootstrap.set(tab.id, window.id);
      }
      await api.sessions.setWindowValue(window.id, WINDOW_TAG, wid);
      this.windowIds.set(window.id, wid);
      windows.set(wid, window);
    }
    // Create/move/update first; close obsolete tabs only after all groups and
    // replacement tabs have been created successfully.
    for (const [id, desired] of Object.entries(snapshot.tabs)) {
      const window = windows.get(desired.placement.window);
      if (!window || (!replace && this.closedWindows.has(desired.placement.window))) continue;
      let tab = nativeTabs.get(id);
      if (!tab) {
        tab = await api.tabs.create({ windowId: window.id, url: desired.url, active: false, pinned: desired.pinned });
        await api.sessions.setTabValue(tab.id, TAB_TAG, id);
        this.tabIds.set(tab.id, id);
        nativeTabs.set(id, tab);
      } else {
        if (tab.windowId !== window.id) {
          if (tab.groupId !== undefined && tab.groupId !== -1) await api.tabs.ungroup([tab.id]);
          await api.tabs.move(tab.id, { windowId: window.id, index: -1 });
        }
        const updates = {};
        if (syncUrl(tab.pendingUrl || tab.url) !== desired.url) updates.url = desired.url;
        if (!!tab.pinned !== desired.pinned) updates.pinned = desired.pinned;
        if (Object.keys(updates).length) await api.tabs.update(tab.id, updates);
      }
    }
    for (const wid of desiredWindows) {
      const window = windows.get(wid);
      if (!window || (!replace && this.closedWindows.has(wid))) continue;
      const ordered = orderedTabs(snapshot, wid);
      const actual = await api.tabs.query({ windowId: window.id });
      const targetNativeIds = ordered.map(([id]) => nativeTabs.get(id)?.id).filter(id => id !== undefined);
      const syncedActual = actual.filter(t => targetNativeIds.includes(t.id));
      const layoutChanged = !same(syncedActual.map(t => t.id), targetNativeIds) || syncedActual.some(t => {
        const desired = snapshot.tabs[this.tabIds.get(t.id)];
        const localGroup = this.groupIds.get(t.groupId) || null;
        return localGroup !== desired?.placement.group;
      });
      if (layoutChanged) {
        const grouped = actual.filter(t => targetNativeIds.includes(t.id) && t.groupId !== undefined && t.groupId !== -1).map(t => t.id);
        if (grouped.length) await api.tabs.ungroup(grouped);
        for (let index = 0; index < targetNativeIds.length; index++) await api.tabs.move(targetNativeIds[index], { windowId: window.id, index });
      }
      const byGroup = new Map();
      for (const [id, tab] of ordered) {
        await api.sessions.setTabValue(nativeTabs.get(id).id, GROUP_TAG, tab.placement.group);
        if (tab.placement.group) {
          const list = byGroup.get(tab.placement.group) || [];
          list.push(nativeTabs.get(id).id);
          byGroup.set(tab.placement.group, list);
        }
      }
      for (const [gid, tabIds] of byGroup) {
        const metadata = snapshot.groups[gid];
        let native = before.nativeGroups.get(gid);
        if (layoutChanged || !native || native.windowId !== window.id) {
          // An existing group may still contain excluded internal/local tabs.
          // Reuse it instead of creating two native groups for one identity.
          const surviving = native && (await api.tabGroups.query({})).find(g => g.id === native.id && g.windowId === window.id);
          const id = await api.tabs.group(surviving ? { groupId: surviving.id, tabIds } : { tabIds, createProperties: { windowId: window.id } });
          native = surviving || { id };
          this.groupIds.set(id, gid);
          before.nativeGroups.set(gid, native);
        }
        const updates = {};
        for (const name of ['title', 'color', 'collapsed']) if (native[name] !== metadata[name]) updates[name] = metadata[name];
        if (Object.keys(updates).length) await api.tabGroups.update(native.id, updates);
      }
    }
    const obsolete = [...before.nativeTabs.entries()].filter(([id]) =>
      !snapshot.tabs[id] && (replace || model.records[id]?.deleted)).map(([, tab]) => tab.id);
    if (obsolete.length) {
      await this.removeTabs(obsolete);
    }
    // Final ordering must happen after obsolete pinned tabs are closed. Firefox
    // clamps unpinned moves behind all pinned tabs; moving tab groups as units
    // also preserves membership and any excluded pages already in that group.
    for (const wid of desiredWindows) {
      const window = windows.get(wid);
      if (!window || (!replace && this.closedWindows.has(wid))) continue;
      const ordered = orderedTabs(snapshot, wid);
      const actual = await api.tabs.query({ windowId: window.id });
      let pinnedIndex = 0;
      let index = actual.filter(t => t.pinned).length;
      const movedGroups = new Set();
      for (const [id, desired] of ordered) {
        const tab = nativeTabs.get(id);
        if (desired.pinned) {
          const live = (await api.tabs.query({ windowId: window.id })).find(t => t.id === tab.id);
          if (live.index !== pinnedIndex) await api.tabs.move(tab.id, { windowId: window.id, index: pinnedIndex });
          pinnedIndex++;
        } else if (desired.placement.group) {
          const gid = desired.placement.group;
          if (movedGroups.has(gid)) continue;
          movedGroups.add(gid);
          const native = before.nativeGroups.get(gid);
          const members = (await api.tabs.query({ windowId: window.id })).filter(t => t.groupId === native.id);
          if (Math.min(...members.map(t => t.index)) !== index) await api.tabGroups.move(native.id, { windowId: window.id, index });
          index += members.length;
        } else {
          const live = (await api.tabs.query({ windowId: window.id })).find(t => t.id === tab.id);
          if (live.index !== index) await api.tabs.move(tab.id, { windowId: window.id, index });
          index++;
        }
      }
    }
    // Remove only blank tabs created by windows.create(), never pre-existing
    // internal pages. Leave a blank tab if there is nothing else in its window.
    for (const [id, wid] of bootstrap) {
      if ((await api.tabs.query({ windowId: wid })).length > 1) {
        await this.removeTabs(id);
      }
    }
    return this.capture();
  }
}

// Baseline records the intended remote values, with the actual indices Firefox
// assigned. Unexpected user-created tabs during application remain new local
// edits on the next capture, rather than being silently adopted as synced.
export function appliedBaseline(desired, observed) {
  const baseline = { tabs: {}, groups: {} };
  for (const [id, tab] of Object.entries(desired.tabs)) {
    if (!observed.tabs[id]) continue;
    baseline.tabs[id] = clone(tab);
    baseline.tabs[id].placement.index = observed.tabs[id].placement.index;
  }
  for (const [id, group] of Object.entries(desired.groups)) if (observed.groups[id]) baseline.groups[id] = clone(group);
  return baseline;
}
