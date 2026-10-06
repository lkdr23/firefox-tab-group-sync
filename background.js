import { ProfileSync } from './profile-sync.js';
import { LOCAL_KEY, PREFIX } from './profile-storage.js';

const sync = new ProfileSync(browser);
let timer;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => sync.refresh().catch(() => {}), 1000);
}
async function updateBadge() {
  await sync.ready;
  const state = sync.state;
  await browser.action.setBadgeText({ text: state.error ? '!' : '' });
  await browser.action.setBadgeBackgroundColor({ color: '#b42318' });
  await browser.action.setTitle({ title: state.error ? `Profile sync: ${state.error}` : state.enabled ? 'Profile sync enabled · Firefox handles cloud transfer' : 'Profile sync paused' });
}

// Register synchronously so Firefox can wake the MV3 event page.
browser.tabs.onCreated.addListener(schedule);
browser.tabs.onUpdated.addListener((id, info) => {
  if (info.url !== undefined || info.pinned !== undefined || info.groupId !== undefined || info.status === 'complete') schedule();
});
browser.tabs.onMoved.addListener(schedule);
browser.tabs.onAttached.addListener(schedule);
browser.tabs.onDetached.addListener(schedule);
browser.tabs.onRemoved.addListener((id, info) => {
  sync.ready.then(() => sync.rememberClose(id, info)).catch(() => {});
  schedule();
});
browser.windows.onCreated.addListener(schedule);
browser.windows.onRemoved.addListener(schedule);
if (browser.tabGroups) {
  browser.tabGroups.onCreated.addListener(schedule);
  browser.tabGroups.onUpdated.addListener(schedule);
  browser.tabGroups.onMoved.addListener(schedule);
  browser.tabGroups.onRemoved.addListener(schedule);
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && Object.keys(changes).some(key => key.startsWith(PREFIX))) schedule();
  if (area === 'local' && changes[LOCAL_KEY]) updateBadge().catch(() => {});
});
browser.runtime.onMessage.addListener((message, sender) => {
  // Only our extension pages may request replacement operations.
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(''))) return undefined;
  const handlers = {
    profileStatus: () => sync.inspect(),
    profileEnable: () => sync.enable(message.mode),
    profileDisable: () => sync.disable(),
    profileChooseAgain: () => sync.chooseAgain(),
    profileRefresh: () => sync.refresh(),
    profileBackup: () => sync.getBackup(),
    profileRestoreBackup: () => sync.restoreBackup()
  };
  if (!Object.prototype.hasOwnProperty.call(handlers, message?.type)) return undefined;
  return Promise.resolve().then(handlers[message.type]).then(data => ({ ok: true, data }), error => ({ ok: false, error: error.message || String(error) }));
});
sync.ready.then(async () => {
  await updateBadge();
  if (sync.state.enabled) schedule();
}).catch(error => console.error('Profile sync startup failed:', error));
