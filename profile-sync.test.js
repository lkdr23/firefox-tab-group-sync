/** @jest-environment node */
import { ProfileSync } from './profile-sync.js';
import { ProfileStorage, LOCAL_KEY, PREFIX } from './profile-storage.js';
import { materialize } from './profile-model.js';
import { copy, exchange, fakeBrowser, testCodec } from './test-support/fake-browser.js';

const make = api => {
  const engine = new ProfileSync(api, { cloud: new ProfileStorage(api, testCodec) });
  if (api.removalListener) api.tabs.onRemoved.removeListener(api.removalListener);
  api.removalListener = (id, info) => engine.rememberClose(id, info);
  api.tabs.onRemoved.addListener(api.removalListener);
  return engine;
};
const urls = api => [...api.nativeTabs.values()].map(t => t.url).filter(u => u.startsWith('http')).sort();
async function group(api, tabIds, title = 'Work', color = 'blue') {
  const id = await api.tabs.group({ tabIds });
  await api.tabGroups.update(id, { title, color });
  return id;
}
async function startPair() {
  const a = fakeBrowser(['https://one.example/path/', 'https://two.example/']);
  const b = fakeBrowser(['https://old-local.example/', 'about:config']);
  const left = make(a), right = make(b);
  await left.ready; await right.ready;
  await left.enable('push'); exchange(a, b); await right.enable('pull');
  return { a, b, left, right };
}

test('starts disabled and neither writes sync storage nor changes tabs', async () => {
  const api = fakeBrowser(['https://local.example/']);
  const engine = make(api);
  await engine.ready; await engine.refresh();
  expect(engine.state.enabled).toBe(false);
  expect(api.storage.sync.set).not.toHaveBeenCalled();
  expect(api.tabs.create).not.toHaveBeenCalled();
  expect(api.tabs.remove).not.toHaveBeenCalled();
});
test('first pull makes a durable backup, replaces only web tabs, and can restore locally while paused', async () => {
  const { a, b, right } = await startPair();
  expect(urls(b)).toEqual(urls(a));
  expect([...b.nativeTabs.values()].some(t => t.url === 'about:config')).toBe(true);
  expect(Object.values(right.state.backups[0].snapshot.tabs).map(t => t.url)).toEqual(['https://old-local.example/']);
  await right.restoreBackup();
  expect(urls(b)).toEqual(['https://old-local.example/']);
  expect(right.state.enabled).toBe(false);
  expect(right.state.initialized).toBe(false);
});
test('pull with no received session refuses to remove local tabs', async () => {
  const api = fakeBrowser(['https://local.example/']);
  const engine = make(api);
  await expect(engine.enable('pull')).rejects.toThrow('No cloud session');
  expect(engine.state.enabled).toBe(false);
  expect(api.tabs.remove).not.toHaveBeenCalled();
});
test('three devices merge offline additions, a closure, a new group, and a rename', async () => {
  const { a, b, left, right } = await startPair();
  const c = fakeBrowser(); const third = make(c);
  exchange(a, b, c); await third.enable('pull');
  a.addTab({ url: 'https://from-a.example/' });
  const bTab = [...b.nativeTabs.values()].find(t => t.url === 'https://one.example/path/');
  await b.tabs.remove(bTab.id); await right.queue;
  const cTab = c.addTab({ url: 'https://from-c.example/' });
  const gid = await group(c, [cTab.id], 'New group');
  await left.refresh(); await right.refresh(); await third.refresh();
  await c.tabGroups.update(gid, { title: 'Renamed group', color: 'purple' });
  await third.refresh();
  exchange(a, b, c);
  await left.refresh(); await right.refresh(); await third.refresh();
  expect(urls(a)).toEqual(['https://from-a.example/', 'https://from-c.example/', 'https://two.example/']);
  expect(urls(b)).toEqual(urls(a)); expect(urls(c)).toEqual(urls(a));
  for (const api of [a, b, c]) expect([...api.nativeGroups.values()].some(g => g.title === 'Renamed group' && g.color === 'purple')).toBe(true);
});
test('remote application does not produce an echo upload on the receiver', async () => {
  const { a, b, left, right } = await startPair();
  a.addTab({ url: 'https://new.example/' });
  await left.refresh(); exchange(a, b);
  b.storage.sync.set.mockClear();
  await right.refresh(); await right.refresh();
  expect(b.storage.sync.set).not.toHaveBeenCalled();
});
test('syncs pinning, ungrouping and tab ordering without collapsing duplicate URLs', async () => {
  const a = fakeBrowser(['https://same.example/', 'https://same.example/', 'https://loose.example/']);
  const b = fakeBrowser();
  const ids = [...a.nativeTabs.keys()];
  await group(a, ids.slice(0, 2));
  const left = make(a), right = make(b);
  await left.enable('push'); exchange(a, b); await right.enable('pull');
  expect(urls(b).filter(u => u === 'https://same.example/')).toHaveLength(2);
  await a.tabs.ungroup([ids[1]]);
  await a.tabs.update(ids[2], { pinned: true });
  await a.tabs.move(ids[2], { index: 0 });
  await left.refresh(); exchange(a, b); await right.refresh();
  const ordered = [...b.nativeTabs.values()].filter(t => t.url.startsWith('http')).sort((x, y) => x.index - y.index);
  expect(ordered[0]).toMatchObject({ url: 'https://loose.example/', pinned: true, groupId: -1 });
  expect(ordered.filter(t => t.url === 'https://same.example/' && t.groupId === -1)).toHaveLength(1);
});
test('session identities survive native tab, group and window ID changes on restart', async () => {
  const api = fakeBrowser(['https://one.example/', 'https://two.example/']);
  await group(api, [...api.nativeTabs.keys()]);
  const first = make(api); await first.enable('push');
  const before = materialize(first.model());
  api.restartNativeIds();
  const restarted = make(api); await restarted.ready;
  api.storage.sync.set.mockClear();
  await restarted.refresh();
  expect(materialize(restarted.model())).toEqual(before);
  expect(api.storage.sync.set).not.toHaveBeenCalled();
  expect(urls(api)).toHaveLength(2);
});
test('closing a window does not delete its tabs or reopen it during this browser session', async () => {
  const { a, b, left, right } = await startPair();
  const id = [...a.nativeWindows.keys()][0];
  a.closeWindow(id); await left.queue;
  a.addWindow({ url: 'about:newtab' });
  await left.refresh(); exchange(a, b); await right.refresh();
  expect(urls(a)).toEqual([]);
  expect(urls(b)).toEqual(['https://one.example/path/', 'https://two.example/']);
  expect(Object.keys(materialize(left.model()).tabs)).toHaveLength(2);
});
test('normal private-profile windows sync but private browsing and local URLs are excluded', async () => {
  const api = fakeBrowser(['https://normal.example/', 'file:///private.txt', 'about:config']);
  api.addWindow({ url: 'https://incognito.example/', incognito: true });
  api.addWindow({ url: 'https://popup.example/', type: 'popup' });
  const engine = make(api); await engine.enable('push');
  expect(Object.values(materialize(engine.model()).tabs).map(t => t.url)).toEqual(['https://normal.example/']);
});
test('offline/quota failure retains edits across restart and retries without removing tabs', async () => {
  const { a, left } = await startPair();
  a.addTab({ url: 'https://pending.example/' });
  left.cloud.publish = jest.fn().mockRejectedValue(new Error('Quota exceeded'));
  await expect(left.refresh()).rejects.toThrow('Quota exceeded');
  expect(a.localData[LOCAL_KEY].pending).toBe(true);
  const restarted = make(a); await restarted.refresh();
  expect(restarted.state.pending).toBe(false);
  expect(Object.values(materialize(restarted.model()).tabs).some(t => t.url === 'https://pending.example/')).toBe(true);
});
test('pause blocks uploads and remote application, resume merges local changes', async () => {
  const { a, b, left, right } = await startPair();
  await right.disable();
  a.addTab({ url: 'https://remote.example/' }); await left.refresh(); exchange(a, b);
  b.addTab({ url: 'https://paused-local.example/' });
  b.storage.sync.set.mockClear(); await right.refresh();
  expect(urls(b)).not.toContain('https://remote.example/');
  expect(b.storage.sync.set).not.toHaveBeenCalled();
  await right.enable();
  expect(urls(b)).toEqual(['https://one.example/path/', 'https://paused-local.example/', 'https://remote.example/', 'https://two.example/']);
});
test('Undo Close Tab before flush becomes a new identity, rather than resurrecting a tombstone', async () => {
  const api = fakeBrowser(['https://one.example/']); const engine = make(api); await engine.enable('push');
  const originalId = [...api.nativeTabs.keys()][0];
  const tag = copy(api.tabValues.get(originalId));
  await api.tabs.remove(originalId); await engine.queue;
  const restored = api.addTab({ url: 'https://one.example/' });
  api.tabValues.set(restored.id, tag);
  await engine.refresh();
  expect(urls(api)).toEqual(['https://one.example/']);
  const old = tag['profile-sync-tab'];
  expect(engine.model().records[old].deleted.v).toBe(true);
  expect(api.tabValues.get(restored.id)['profile-sync-tab']).not.toBe(old);
});
test('incomplete delivered chunks block replacement and keep local state recoverable', async () => {
  const { a, b, left, right } = await startPair();
  a.addTab({ url: 'https://new.example/' }); await left.refresh(); exchange(a, b);
  b.syncData[`${PREFIX}broken`] = { schema: 1, revision: 'revision', hash: 'missing', chunks: 2 };
  const prior = urls(b);
  await expect(right.refresh()).rejects.toThrow('Waiting for complete');
  expect(urls(b)).toEqual(prior);
  expect(right.state.error).toMatch('Waiting for complete');
});
test('a newly chosen cloud starting state backs up and replaces an already enabled stale device', async () => {
  const { a, b, left } = await startPair();
  a.addTab({ url: 'https://old-offline.example/' }); await left.refresh();
  const resetApi = fakeBrowser(['https://reset.example/']); exchange(b, resetApi);
  const reset = make(resetApi); await reset.enable('push'); exchange(a, resetApi);
  await left.refresh();
  expect(urls(a)).toEqual(['https://reset.example/']);
  expect(Object.values(left.state.backups[0].snapshot.tabs).some(t => t.url === 'https://old-offline.example/')).toBe(true);
});
test('failed replacement is retried after restart before partial browser mutations become uploads', async () => {
  const a = fakeBrowser(['https://one.example/', 'https://two.example/']); const left = make(a); await left.enable('push');
  const b = fakeBrowser(['https://old.example/']); exchange(a, b); const right = make(b);
  const create = b.tabs.create.getMockImplementation();
  b.tabs.create.mockImplementationOnce(create).mockRejectedValueOnce(new Error('Creation interrupted'));
  await expect(right.enable('pull')).rejects.toThrow('Creation interrupted');
  expect(urls(b)).toContain('https://old.example/');
  expect(right.state.applyPending).toBeTruthy();
  const restarted = make(b); await restarted.refresh();
  expect(urls(b)).toEqual(urls(a));
  expect(b.storage.sync.set).not.toHaveBeenCalled();
});
test('closed windows stay closed across background event-page suspension within a browser session', async () => {
  const { a, left } = await startPair();
  a.closeWindow([...a.nativeWindows.keys()][0]); await left.queue;
  a.addWindow({ url: 'about:newtab' });
  const resumed = make(a); await resumed.refresh();
  expect(urls(a)).toEqual([]);
  expect(Object.keys(materialize(resumed.model()).tabs)).toHaveLength(2);
});
test('a cloud-closed tab is not reidentified as a local reopening after an incoming apply fails', async () => {
  const { a, b, left, right } = await startPair();
  const tab = [...a.nativeTabs.values()].find(t => t.url === 'https://one.example/path/');
  await a.tabs.remove(tab.id); await left.queue; await left.refresh(); exchange(a, b);
  b.tabs.remove.mockRejectedValueOnce(new Error('Removal interrupted'));
  await expect(right.refresh()).rejects.toThrow('Removal interrupted');
  expect(urls(b)).toContain('https://one.example/path/');
  const resumed = make(b); await resumed.refresh(); await resumed.refresh();
  expect(urls(b)).toEqual(['https://two.example/']);
  expect(Object.keys(materialize(resumed.model()).tabs)).toHaveLength(1);
});
test('incoming closure is retained across a failed pending write before application', async () => {
  const { a, b, left, right } = await startPair();
  const tab = [...a.nativeTabs.values()].find(t => t.url === 'https://one.example/path/');
  await a.tabs.remove(tab.id); await left.queue; await left.refresh(); exchange(a, b);
  b.addTab({ url: 'https://pending-local.example/' });
  right.cloud.publish = jest.fn().mockRejectedValue(new Error('Storage full'));
  await expect(right.refresh()).rejects.toThrow('Storage full');
  const resumed = make(b); await resumed.refresh(); await resumed.refresh();
  expect(urls(b)).toEqual(['https://pending-local.example/', 'https://two.example/']);
});
test('replacing a pinned local tab preserves remote group order after it is removed', async () => {
  const a = fakeBrowser(['https://one.example/', 'https://two.example/']);
  const ids = [...a.nativeTabs.keys()];
  await group(a, [ids[0]], 'First'); await group(a, [ids[1]], 'Second');
  const left = make(a); await left.enable('push');
  const b = fakeBrowser(['https://obsolete.example/']);
  await b.tabs.update([...b.nativeTabs.keys()][0], { pinned: true });
  exchange(a, b); const right = make(b); await right.enable('pull');
  const ordered = [...b.nativeTabs.values()].sort((x, y) => x.index - y.index).map(t => t.url);
  expect(ordered).toEqual(['https://one.example/', 'https://two.example/']);
  b.storage.sync.set.mockClear(); await right.refresh();
  expect(b.storage.sync.set).not.toHaveBeenCalled();
});
test('regrouping keeps excluded pages in the existing group without splitting its identity', async () => {
  const api = fakeBrowser(['https://one.example/', 'about:config', 'https://two.example/']);
  const ids = [...api.nativeTabs.keys()];
  await group(api, ids.slice(0, 2), 'Mixed');
  const engine = make(api); await engine.enable('push');
  const before = [...api.nativeGroups.keys()][0];
  await api.tabs.group({ groupId: before, tabIds: [ids[2]] });
  await engine.refresh(); await engine.refresh();
  expect(api.nativeGroups.size).toBe(1);
  expect([...api.nativeTabs.values()].filter(t => t.groupId === [...api.nativeGroups.keys()][0])).toHaveLength(3);
});
test('capture includes a pending web URL before navigation commits', async () => {
  const api = fakeBrowser(['about:blank']);
  [...api.nativeTabs.values()][0].pendingUrl = 'https://pending.example/';
  const engine = make(api); await engine.enable('push');
  expect(Object.values(materialize(engine.model()).tabs).map(t => t.url)).toEqual(['https://pending.example/']);
});
test('a closure waking an unloaded background page uses the previous native mapping', async () => {
  const { a, b, left, right } = await startPair();
  const native = [...a.nativeTabs.values()].find(t => t.url === 'https://one.example/path/');
  a.tabs.onRemoved.removeListener(a.removalListener);
  // Close first: Firefox wakes a new background only after this tab is gone.
  await a.tabs.remove(native.id);
  const awakened = make(a); await awakened.ready;
  await awakened.rememberClose(native.id, { windowId: native.windowId, isWindowClosing: false });
  await awakened.refresh(); exchange(a, b); await right.refresh();
  expect(urls(b)).toEqual(['https://two.example/']);
});
test('a window closure waking an unloaded page preserves the window without reopening it', async () => {
  const { a } = await startPair();
  const native = [...a.nativeTabs.values()].find(t => t.url.startsWith('https'));
  a.tabs.onRemoved.removeListener(a.removalListener);
  a.closeWindow(native.windowId); a.addWindow({ url: 'about:newtab' });
  const awakened = make(a); await awakened.ready;
  await awakened.rememberClose(native.id, { windowId: native.windowId, isWindowClosing: true });
  await awakened.refresh();
  expect(urls(a)).toEqual([]);
  expect(Object.keys(materialize(awakened.model()).tabs)).toHaveLength(2);
});
test('closing excluded Firefox pages does not fill the cloud with unused deletion records', async () => {
  const api = fakeBrowser(['https://one.example/', 'about:config']);
  const engine = make(api); await engine.enable('push');
  const localPage = [...api.nativeTabs.values()].find(t => t.url === 'about:config');
  await api.tabs.remove(localPage.id); await engine.queue; await engine.refresh();
  expect(Object.values(engine.model().records).some(fields => fields.deleted)).toBe(false);
});
test('a tab disappearing during background initialization does not permanently break sync', async () => {
  const api = fakeBrowser(['https://one.example/']);
  api.windows.getAll.mockRejectedValueOnce(new Error('Window disappeared'));
  const engine = make(api); await engine.ready;
  expect(engine.state.error).toMatch('Save & refresh');
  await engine.enable('push');
  expect(engine.state.error).toBeNull();
  expect(engine.state.enabled).toBe(true);
});
