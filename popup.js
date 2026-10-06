import { LOCAL_KEY, PREFIX } from './profile-storage.js';

const $ = id => document.getElementById(id);
let state;
let busy = false;
let choosing = false;
async function request(type, extra = {}) {
  const response = await browser.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || 'Could not reach the background script. Reload the extension and try again.');
  return response.data;
}
const time = timestamp => timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
function render() {
  if (!state) return;
  $('enabled').checked = state.enabled || choosing;
  $('enabled').disabled = busy || !state.supported;
  $('setup').hidden = !choosing;
  $('refresh').disabled = busy || !state.supported;
  const mode = document.querySelector('input[name=start]:checked')?.value;
  $('confirm').disabled = busy || !mode || (mode === 'pull' && (!state.cloud || state.cloudError));
  $('cancel').disabled = busy;
  for (const input of document.querySelectorAll('input[name=start]')) input.disabled = busy || (input.value === 'pull' && (!state.cloud || state.cloudError));
  $('status').textContent = !state.supported ? 'Desktop Firefox 139 or newer is required.' : choosing ? 'Select a starting state to enable sync.' : state.enabled ? state.pending ? 'Changes saved locally; waiting to prepare sync.' : 'Sync enabled · cloud transfer handled by Firefox' : state.initialized ? 'Sync paused · local tabs are kept' : 'Sync is off for this profile';
  const error = state.error || state.cloudError;
  $('error').textContent = error || '';
  $('error').hidden = !error;
  $('cloud-summary').textContent = state.cloud ? `${state.cloud.tabs} web tabs in ${state.cloud.groups} groups are available from sync storage on this device.` : 'No cloud session is available on this device yet.';
  $('prepared').textContent = time(state.lastPrepared);
  $('received').textContent = time(state.lastReceived);
  $('usage').textContent = state.usage ? `${(state.usage.bytes / 1024).toFixed(1)} / 100 KB` : 'Unavailable';
  $('backup-summary').textContent = state.backup ? `${state.backup.reason}. Saved ${new Date(state.backup.createdAt).toLocaleString()}.` : 'No replacement backup yet.';
  $('download').disabled = busy || !state.backup;
  $('restore').disabled = busy || !state.backup || !state.supported;
  $('restore-yes').disabled = busy;
  $('restore-cancel').disabled = busy;
  $('choose-again').disabled = busy || !state.supported;
}
async function load() { state = await request('profileStatus'); render(); }
async function act(operation) {
  if (busy) return;
  busy = true;
  render();
  let failure;
  try { await operation(); } catch (error) { failure = error.message; }
  try { await load(); } catch (error) { failure ||= error.message; }
  busy = false;
  render();
  if (failure) { $('error').textContent = failure; $('error').hidden = false; }
}
$('enabled').addEventListener('change', () => {
  if (!$('enabled').checked) {
    choosing = false;
    act(() => request('profileDisable'));
  } else if (!state.initialized) {
    choosing = true;
    document.querySelectorAll('input[name=start]').forEach(input => { input.checked = false; });
    render();
  } else act(() => request('profileEnable'));
});
$('cancel').addEventListener('click', () => { choosing = false; render(); });
document.querySelectorAll('input[name=start]').forEach(input => input.addEventListener('change', render));
$('confirm').addEventListener('click', () => act(async () => {
  const mode = document.querySelector('input[name=start]:checked')?.value;
  await request('profileEnable', { mode });
  choosing = false;
}));
$('refresh').addEventListener('click', () => act(() => request('profileRefresh')));
$('download').addEventListener('click', () => act(async () => {
  const backup = await request('profileBackup');
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `profile-tabs-backup-${new Date(backup.createdAt).toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}));
$('restore').addEventListener('click', () => { $('restore-confirm').hidden = false; });
$('choose-again').addEventListener('click', () => act(async () => {
  await request('profileChooseAgain');
  choosing = true;
  document.querySelectorAll('input[name=start]').forEach(input => { input.checked = false; });
}));
$('restore-cancel').addEventListener('click', () => { $('restore-confirm').hidden = true; });
$('restore-yes').addEventListener('click', () => act(async () => {
  await request('profileRestoreBackup');
  choosing = false;
  $('restore-confirm').hidden = true;
}));
browser.storage.onChanged.addListener((changes, area) => {
  if (busy) return;
  if ((area === 'local' && changes[LOCAL_KEY]) || (area === 'sync' && Object.keys(changes).some(k => k.startsWith(PREFIX)))) load().catch(() => {});
});
load().catch(error => { $('status').textContent = 'Could not load sync settings.'; $('error').textContent = error.message; $('error').hidden = false; });
