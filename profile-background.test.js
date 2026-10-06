/** @jest-environment node */
import { fakeBrowser } from './test-support/fake-browser.js';

let api, engine;
jest.mock('./profile-sync.js', () => ({ ProfileSync: jest.fn() }));
beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers();
  api = fakeBrowser();
  api.runtime.getURL = path => `moz-extension://own/${path}`;
  engine = {
    ready: Promise.resolve(), state: { enabled: false },
    inspect: jest.fn(async () => ({ enabled: false })), enable: jest.fn(async () => {}), disable: jest.fn(async () => {}),
    chooseAgain: jest.fn(async () => {}), refresh: jest.fn(async () => {}), getBackup: jest.fn(async () => ({})),
    restoreBackup: jest.fn(async () => {}), rememberClose: jest.fn(async () => {})
  };
  require('./profile-sync.js').ProfileSync.mockImplementation(() => engine);
  global.browser = api;
  await import('./background.js');
  await Promise.resolve();
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
test('does not auto-save on a disabled profile startup', async () => {
  await jest.runOnlyPendingTimersAsync();
  expect(engine.refresh).not.toHaveBeenCalled();
  expect(engine.enable).not.toHaveBeenCalled();
});
test('accepts messages only from its own extension pages, including extension tabs', async () => {
  const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
  expect(listener({ type: 'profileEnable', mode: 'pull' }, { id: api.runtime.id, url: 'https://example.com/', tab: {} })).toBeUndefined();
  expect(listener({ type: 'profileEnable', mode: 'pull' }, { id: 'other', url: 'moz-extension://own/popup.html' })).toBeUndefined();
  const result = await listener({ type: 'profileEnable', mode: 'pull' }, { id: api.runtime.id, url: 'moz-extension://own/popup.html', tab: { id: 1 } });
  expect(result.ok).toBe(true);
  expect(engine.enable).toHaveBeenCalledTimes(1);
  expect(engine.enable).toHaveBeenCalledWith('pull');
  expect(listener({ type: '__proto__' }, { id: api.runtime.id, url: 'moz-extension://own/popup.html' })).toBeUndefined();
});
test('captures creation, regrouping, movement, closures and remote delivery even with popup closed', async () => {
  api.tabs.onCreated.emit({ id: 10 });
  api.tabs.onUpdated.emit(10, { groupId: 2 });
  api.tabs.onAttached.emit(10, {});
  api.tabs.onRemoved.emit(10, { windowId: 1, isWindowClosing: false });
  api.tabGroups.onCreated.emit({ id: 2 });
  api.storage.onChanged.emit({ profile_v1_peer: { newValue: {} } }, 'sync');
  await jest.runOnlyPendingTimersAsync();
  expect(engine.refresh).toHaveBeenCalledTimes(1);
  expect(engine.rememberClose).toHaveBeenCalledWith(10, { windowId: 1, isWindowClosing: false });
});
