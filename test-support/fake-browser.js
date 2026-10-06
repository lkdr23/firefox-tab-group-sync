// Stateful Firefox API fake: integration tests exercise actual capture/apply,
// independent per-device sync replicas, and session tags surviving native IDs.
export const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const event = () => {
  const listeners = [];
  return {
    addListener: jest.fn(fn => listeners.push(fn)),
    removeListener: jest.fn(fn => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); }),
    emit: (...args) => [...listeners].forEach(fn => fn(...args))
  };
};
function area(store) {
  return {
    get: jest.fn(async keys => keys === null ? copy(store) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, copy(store[k])]))),
    set: jest.fn(async values => Object.assign(store, copy(values))),
    remove: jest.fn(async keys => (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete store[k]; }))
  };
}
export function fakeBrowser(urls = ['about:newtab']) {
  const localData = {}, syncData = {}, sessionData = {};
  let nextTab = 1, nextWindow = 1, nextGroup = 1;
  const windows = new Map(), tabs = new Map(), groups = new Map();
  const tabValues = new Map(), windowValues = new Map();
  const api = {
    localData, syncData, nativeTabs: tabs, nativeWindows: windows, nativeGroups: groups, tabValues, windowValues,
    storage: { local: area(localData), sync: area(syncData), session: area(sessionData), onChanged: event() },
    runtime: { id: 'profile-sync@firefox-tab-group-sync', onMessage: event(), sendMessage: jest.fn() },
    action: { setTitle: jest.fn(), setBadgeText: jest.fn(), setBadgeBackgroundColor: jest.fn() },
    sessions: {
      getTabValue: jest.fn(async (id, key) => copy(tabValues.get(id)?.[key])),
      setTabValue: jest.fn(async (id, key, value) => { if (!tabs.has(id)) throw new Error('No such tab'); tabValues.set(id, { ...tabValues.get(id), [key]: copy(value) }); }),
      getWindowValue: jest.fn(async (id, key) => copy(windowValues.get(id)?.[key])),
      setWindowValue: jest.fn(async (id, key, value) => { if (!windows.has(id)) throw new Error('No such window'); windowValues.set(id, { ...windowValues.get(id), [key]: copy(value) }); })
    },
    tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(), onAttached: event(), onDetached: event() },
    windows: { onCreated: event(), onRemoved: event() },
    tabGroups: { onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event() }
  };
  const list = wid => [...tabs.values()].filter(t => t.windowId === wid).sort((a, b) => a.index - b.index);
  function normalize(wid) {
    list(wid).forEach((t, i) => { t.index = i; });
    for (const [id, group] of groups) {
      const members = [...tabs.values()].filter(t => t.groupId === id);
      if (!members.length) groups.delete(id);
      else group.windowId = members[0].windowId;
    }
  }
  function addWindow({ url = 'about:blank', incognito = false, type = 'normal' } = {}) {
    const window = { id: nextWindow++, incognito, type };
    windows.set(window.id, window);
    for (const entry of Array.isArray(url) ? url : [url]) addTab({ windowId: window.id, url: entry });
    return { ...copy(window), tabs: copy(list(window.id)) };
  }
  function addTab({ windowId = [...windows.keys()][0], url = 'about:newtab', pinned = false, active = false, index = -1 } = {}) {
    const window = windows.get(windowId);
    if (!window) throw new Error('Invalid window');
    const ordered = list(windowId);
    const tab = { id: nextTab++, windowId, url, pinned, active, groupId: -1, incognito: window.incognito, index: index < 0 ? ordered.length : index };
    ordered.filter(t => t.index >= tab.index).forEach(t => { t.index++; });
    tabs.set(tab.id, tab);
    normalize(windowId);
    api.tabs.onCreated.emit(copy(tab));
    return copy(tab);
  }
  Object.assign(api.windows, {
    getAll: jest.fn(async ({ windowTypes } = {}) => [...windows.values()].filter(w => !windowTypes || windowTypes.includes(w.type)).map(w => ({ ...copy(w), tabs: copy(list(w.id)) }))),
    create: jest.fn(async props => { const w = addWindow(props); api.windows.onCreated.emit(w); return w; })
  });
  Object.assign(api.tabs, {
    query: jest.fn(async query => copy([...tabs.values()].filter(t => Object.entries(query).every(([key, value]) => t[key] === value)))),
    create: jest.fn(async props => addTab(props)),
    update: jest.fn(async (id, props) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error('No such tab');
      Object.assign(tab, props);
      if (tab.pinned) tab.groupId = -1;
      normalize(tab.windowId);
      api.tabs.onUpdated.emit(id, copy(props), copy(tab));
      return copy(tab);
    }),
    move: jest.fn(async (id, props) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error('No such tab');
      const from = tab.windowId;
      const to = props.windowId ?? from;
      const ordered = list(to).filter(t => t.id !== id);
      const pinnedCount = ordered.filter(t => t.pinned).length;
      const requested = props.index < 0 ? ordered.length : Math.min(props.index, ordered.length);
      const index = tab.pinned ? Math.min(requested, pinnedCount) : Math.max(requested, pinnedCount);
      tab.windowId = to;
      if (to !== from) tab.groupId = -1;
      ordered.splice(index, 0, tab);
      ordered.forEach((t, i) => { t.index = i; });
      normalize(from);
      normalize(to);
      api.tabs.onMoved.emit(id, { windowId: to, fromIndex: 0, toIndex: index });
      return copy(tab);
    }),
    ungroup: jest.fn(async ids => {
      for (const id of Array.isArray(ids) ? ids : [ids]) { const tab = tabs.get(id); if (tab) { tab.groupId = -1; normalize(tab.windowId); } }
    }),
    group: jest.fn(async ({ tabIds, groupId }) => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      if (ids.some(id => !tabs.has(id) || tabs.get(id).pinned)) throw new Error('Cannot group pinned or missing tab');
      if (new Set(ids.map(id => tabs.get(id).windowId)).size !== 1) throw new Error('Group must be in one window');
      const id = groupId ?? nextGroup++;
      if (!groups.has(id)) groups.set(id, { id, windowId: tabs.get(ids[0]).windowId, title: '', color: 'grey', collapsed: false });
      ids.forEach(tid => { tabs.get(tid).groupId = id; });
      api.tabGroups.onCreated.emit(copy(groups.get(id)));
      return id;
    }),
    remove: jest.fn(async ids => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No such tab');
        tabs.delete(id);
        normalize(tab.windowId);
        api.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false });
      }
    })
  });
  Object.assign(api.tabGroups, {
    query: jest.fn(async () => copy([...groups.values()])),
    move: jest.fn(async (id, props) => {
      const group = groups.get(id);
      if (!group) throw new Error('No such group');
      const members = list(group.windowId).filter(t => t.groupId === id);
      const targetWindow = props.windowId ?? group.windowId;
      const ordered = list(targetWindow).filter(t => t.groupId !== id);
      const index = Math.max(props.index < 0 ? ordered.length : props.index, ordered.filter(t => t.pinned).length);
      members.forEach(t => { t.windowId = targetWindow; });
      ordered.splice(index, 0, ...members);
      ordered.forEach((t, i) => { t.index = i; });
      group.windowId = targetWindow;
      return copy(group);
    }),
    update: jest.fn(async (id, props) => {
      if (!groups.has(id)) throw new Error('No such group');
      Object.assign(groups.get(id), props);
      api.tabGroups.onUpdated.emit(copy(groups.get(id)));
      return copy(groups.get(id));
    })
  });
  api.addWindow = addWindow;
  api.addTab = addTab;
  api.closeWindow = wid => {
    for (const tab of list(wid)) {
      tabs.delete(tab.id);
      api.tabs.onRemoved.emit(tab.id, { windowId: wid, isWindowClosing: true });
    }
    windows.delete(wid);
    normalize(wid);
    api.windows.onRemoved.emit(wid);
  };
  api.restartNativeIds = () => {
    for (const [id, tab] of [...tabs]) {
      const next = nextTab++;
      tabs.delete(id); tab.id = next; tabs.set(next, tab);
      tabValues.set(next, tabValues.get(id)); tabValues.delete(id);
    }
    for (const [id, window] of [...windows]) {
      const next = nextWindow++;
      windows.delete(id); window.id = next; windows.set(next, window);
      windowValues.set(next, windowValues.get(id)); windowValues.delete(id);
      for (const tab of tabs.values()) if (tab.windowId === id) tab.windowId = next;
      for (const group of groups.values()) if (group.windowId === id) group.windowId = next;
    }
    for (const [id, group] of [...groups]) {
      const next = nextGroup++;
      groups.delete(id); group.id = next; groups.set(next, group);
      for (const tab of tabs.values()) if (tab.groupId === id) tab.groupId = next;
    }
  };
  addWindow({ url: urls });
  return api;
}
export const testCodec = {
  encode: async doc => JSON.stringify(doc),
  decode: async data => JSON.parse(data),
  hash: async text => require('crypto').createHash('sha256').update(text).digest('hex')
};
export function exchange(...apis) {
  const all = Object.assign({}, ...apis.map(api => copy(api.syncData)));
  // Each writer exclusively owns its key. Deliver that writer's latest local
  // revision; a receiver's stale replica must not overwrite it in the fake.
  for (const api of apis) {
    const device = api.localData.profile_sync_v1?.device;
    if (!device) continue;
    const key = `profile_v1_${device}`;
    for (const [k, value] of Object.entries(api.syncData)) if (k === key || k.startsWith(`${key}:`)) all[k] = copy(value);
  }
  apis.forEach(api => Object.assign(api.syncData, copy(all)));
}
