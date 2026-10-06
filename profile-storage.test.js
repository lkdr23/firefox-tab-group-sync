/** @jest-environment node */
import { ProfileStorage, PREFIX } from './profile-storage.js';
import { emptyDocument, recordChanges } from './profile-model.js';
import { copy, fakeBrowser, testCodec } from './test-support/fake-browser.js';

function document(count = 1, urlSize = 30) {
  const tabs = {};
  for (let i = 0; i < count; i++) tabs[`t_${i}`] = { url: `https://example.com/${i}/${'x'.repeat(urlSize)}`, pinned: false, placement: { window: 'w_main', group: null, index: i } };
  return recordChanges(emptyDocument('writer', [1, 'writer']), { tabs: {}, groups: {} }, { tabs, groups: {} }).document;
}
test('real gzip/base64/checksum round trip restores exact unicode group titles and URLs', async () => {
  const api = fakeBrowser(); const cloud = new ProfileStorage(api);
  const doc = document(200);
  doc.records.g_unicode = { title: { v: '仕事 🦊', r: [doc.clock, doc.device] } };
  await cloud.publish(doc);
  expect((await cloud.read()).documents).toEqual([doc]);
  expect((await cloud.usage()).bytes).toBeLessThan(10000);
});
test('chunks are written before the head, and missing/out-of-order chunks cannot be applied', async () => {
  const api = fakeBrowser(); const cloud = new ProfileStorage(api, testCodec);
  const doc = document(80, 100);
  await cloud.publish(doc);
  const headKey = `${PREFIX}writer`;
  const calls = api.storage.sync.set.mock.calls.map(([payload]) => payload);
  expect(calls[0][headKey]).toBeUndefined();
  expect(calls[1][headKey].chunks).toBeGreaterThan(1);
  const head = api.syncData[headKey];
  const chunkKey = `${headKey}:${head.revision}:0`;
  const saved = api.syncData[chunkKey]; delete api.syncData[chunkKey];
  await expect(cloud.read()).rejects.toThrow('Waiting for complete');
  api.syncData[chunkKey] = saved;
  expect((await cloud.read()).documents).toEqual([doc]);
});
test('quota preflight leaves the previous live revision intact without deleting to make room', async () => {
  const api = fakeBrowser(); const cloud = new ProfileStorage(api, testCodec);
  await cloud.publish(document());
  for (let i = 0; i < 12; i++) api.syncData[`other_${i}`] = 'x'.repeat(7900);
  const before = copy(api.syncData);
  api.storage.sync.set.mockClear(); api.storage.sync.remove.mockClear();
  await expect(cloud.publish(document(80, 100))).rejects.toThrow('100 KB');
  expect(api.syncData).toEqual(before);
  expect(api.storage.sync.set).not.toHaveBeenCalled();
  expect(api.storage.sync.remove).not.toHaveBeenCalled();
});
test('failed manifest publication retains old cloud data and its chunks', async () => {
  const api = fakeBrowser(); const cloud = new ProfileStorage(api, testCodec);
  await cloud.publish(document(50, 100));
  const head = copy(api.syncData[`${PREFIX}writer`]);
  const oldChunks = Object.keys(api.syncData).filter(k => k.includes(`:${head.revision}:`));
  const set = api.storage.sync.set.getMockImplementation();
  api.storage.sync.set.mockImplementationOnce(set).mockRejectedValueOnce(new Error('Offline'));
  await expect(cloud.publish(document(60, 100))).rejects.toThrow('Offline');
  expect(api.syncData[`${PREFIX}writer`]).toEqual(head);
  expect(oldChunks.every(k => k in api.syncData)).toBe(true);
  expect((await cloud.read()).documents).toEqual([document(50, 100)]);
  await cloud.publish(document(60, 100));
  expect((await cloud.read()).documents).toEqual([document(60, 100)]);
  const current = api.syncData[`${PREFIX}writer`];
  expect(Object.keys(api.syncData).filter(k => k.includes(':')).every(k => k.includes(`:${current.revision}:`))).toBe(true);
});
test('corruption, unsafe URLs and unknown schemas are rejected rather than silently skipped', async () => {
  const api = fakeBrowser(); const cloud = new ProfileStorage(api, testCodec);
  await cloud.publish(document());
  api.syncData[`${PREFIX}writer`].data += 'damaged';
  await expect(cloud.read()).rejects.toThrow('damaged');
  const unsafe = document(); unsafe.records.t_0.url.v = 'file:///private';
  await expect(cloud.publish(unsafe)).rejects.toThrow('Invalid synced url');
  api.syncData[`${PREFIX}writer`].schema = 99;
  await expect(cloud.read()).rejects.toThrow('Unsupported');
});
test('uses separate local sync storage for independent Mozilla accounts', async () => {
  const work = fakeBrowser(), personal = fakeBrowser();
  await new ProfileStorage(work, testCodec).publish(document());
  expect((await new ProfileStorage(personal, testCodec).read()).documents).toEqual([]);
});
