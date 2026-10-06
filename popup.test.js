import fs from 'fs';

let status;
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const click = id => document.getElementById(id).click();
beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  document.body.innerHTML = fs.readFileSync(require.resolve('./popup.html'), 'utf8');
  status = { supported: true, enabled: false, initialized: false, pending: false, cloud: null, usage: { bytes: 0 }, backup: null };
  browser.runtime.sendMessage.mockImplementation(async message => {
    if (message.type === 'profileStatus') return { ok: true, data: { ...status } };
    if (message.type === 'profileEnable') { status.enabled = true; status.initialized = true; }
    if (message.type === 'profileDisable') status.enabled = false;
    return { ok: true };
  });
  await import('./popup.js');
  await settle();
});
test('checking first-time sync requires a choice and does not upload before confirmation', async () => {
  click('enabled');
  expect(document.getElementById('setup').hidden).toBe(false);
  expect(document.getElementById('confirm').disabled).toBe(true);
  expect(browser.runtime.sendMessage.mock.calls.some(([m]) => m.type === 'profileEnable')).toBe(false);
  click('cancel');
  expect(document.getElementById('enabled').checked).toBe(false);
  expect(document.getElementById('setup').hidden).toBe(true);
});
test('cloud replacement stays unavailable until a complete received session exists', () => {
  click('enabled');
  expect(document.querySelector('input[value=pull]').disabled).toBe(true);
  expect(document.querySelector('input[value=push]').disabled).toBe(false);
});
test('explicit local choice enables sync; unticking pauses without another setup prompt', async () => {
  click('enabled');
  document.querySelector('input[value=push]').click();
  click('confirm'); await settle();
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'profileEnable', mode: 'push' });
  expect(document.getElementById('enabled').checked).toBe(true);
  expect(document.getElementById('setup').hidden).toBe(true);
  click('enabled'); await settle();
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'profileDisable' });
  expect(document.getElementById('enabled').checked).toBe(false);
});
test('failed initialization remains reviewable without claiming sync has been enabled', async () => {
  browser.runtime.sendMessage.mockImplementation(async message => message.type === 'profileStatus' ? { ok: true, data: status } : { ok: false, error: 'Storage is full' });
  click('enabled'); document.querySelector('input[value=push]').click(); click('confirm'); await settle();
  expect(document.getElementById('error').textContent).toBe('Storage is full');
  expect(document.getElementById('setup').hidden).toBe(false);
  expect(status.enabled).toBe(false);
});
