import { clone, emptyDocument, materialize, mergeDocuments, orderedTabs, recordChanges, syncUrl, validateDocument } from './profile-model.js';

const blank = () => ({ tabs: {}, groups: {} });
const tab = (url = 'https://example.com/path/', group = null, index = 0) => ({ url, pinned: false, placement: { window: 'w_main', group, index } });
const epoch = [100, 'device_a'];
const baseline = { tabs: { t_first: tab(), t_second: tab('https://second.example/') }, groups: {} };
const start = () => recordChanges(emptyDocument('device_a', epoch), blank(), baseline).document;

test('keeps exact URLs, including trailing slash and fragment; rejects privileged schemes', () => {
  expect(syncUrl('https://example.com/path/?x=1#part')).toBe('https://example.com/path/?x=1#part');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'about:config', 'data:text/html,a']) expect(syncUrl(url)).toBeNull();
});
test('three offline writers merge independent additions, closure and group rename', () => {
  const original = start();
  const a = recordChanges(original, baseline, { ...baseline, tabs: { ...baseline.tabs, t_added: tab('https://added.example/') } }).document;
  const b = recordChanges(emptyDocument('device_b', epoch), baseline, baseline, ['t_first'], original.clock).document;
  const c = recordChanges(emptyDocument('device_c', epoch), baseline, { ...baseline, groups: { g_work: { title: 'Research', color: 'blue', collapsed: true } } }, [], original.clock).document;
  const first = mergeDocuments([a, b, c]);
  const reversed = mergeDocuments([c, b, a]);
  expect(materialize(first)).toEqual(materialize(reversed));
  expect(Object.keys(materialize(first).tabs).sort()).toEqual(['t_added', 't_second']);
  expect(materialize(first).groups.g_work.title).toBe('Research');
});
test('concurrent URL and pin changes to the same tab preserve both fields', () => {
  const original = start();
  const url = clone(baseline); url.tabs.t_first.url = 'https://changed.example/';
  const pin = clone(baseline); pin.tabs.t_first.pinned = true;
  const a = recordChanges(original, baseline, url).document;
  const b = recordChanges(emptyDocument('device_b', epoch), baseline, pin, [], original.clock).document;
  expect(materialize(mergeDocuments([a, b])).tabs.t_first).toMatchObject({ url: 'https://changed.example/', pinned: true });
});
test('deletion wins over concurrent or stale navigation and never resurrects an identity', () => {
  const original = start();
  const deleted = recordChanges(emptyDocument('device_b', epoch), baseline, baseline, ['t_first'], original.clock).document;
  const changed = clone(baseline); changed.tabs.t_first.url = 'https://new.example/';
  const a = recordChanges(original, baseline, changed, [], 999).document;
  expect(materialize(mergeDocuments([a, deleted])).tabs.t_first).toBeUndefined();
});
test('missing tabs on startup/window closure are not interpreted as deletions', () => {
  const result = recordChanges(start(), baseline, blank());
  expect(result.changed).toBe(false);
  expect(Object.keys(materialize(mergeDocuments([result.document])).tabs)).toHaveLength(2);
});
test('an explicit new starting epoch replaces stale offline sessions, including an empty session', () => {
  const original = start();
  const reset = emptyDocument('device_c', [200, 'device_c']);
  expect(materialize(mergeDocuments([reset, original])).tabs).toEqual({});
});
test('same-title groups and duplicate URLs remain distinct identities', () => {
  const snapshot = { tabs: { t_one: tab(undefined, 'g_one'), t_two: tab(undefined, 'g_two') }, groups: { g_one: { title: 'Work', color: 'blue', collapsed: false }, g_two: { title: 'Work', color: 'red', collapsed: false } } };
  const doc = recordChanges(emptyDocument('device_a', epoch), blank(), snapshot).document;
  expect(materialize(mergeDocuments([doc]))).toEqual(snapshot);
});
test('conflicting moves of a group converge on a single window', () => {
  const snapshot = { tabs: { t_one: tab(undefined, 'g_one'), t_two: tab(undefined, 'g_one') }, groups: { g_one: { title: 'Work', color: 'blue', collapsed: false } } };
  const a = recordChanges(emptyDocument('device_a', epoch), blank(), snapshot).document;
  const moved = clone(snapshot); moved.tabs.t_two.placement.window = 'w_other';
  const b = recordChanges(emptyDocument('device_b', epoch), snapshot, moved, [], a.clock).document;
  const tabs = materialize(mergeDocuments([a, b])).tabs;
  expect(tabs.t_one.placement.window).toBe('w_other');
  expect(tabs.t_two.placement.window).toBe('w_other');
});
test('orders pinned tabs first and keeps group members contiguous', () => {
  const snapshot = { tabs: { t_one: tab(undefined, 'g_one', 0), t_loose: tab(undefined, null, 1), t_two: tab(undefined, 'g_one', 2), t_pin: { ...tab(undefined, null, 4), pinned: true } }, groups: {} };
  expect(orderedTabs(snapshot, 'w_main').map(([id]) => id)).toEqual(['t_pin', 't_one', 't_two', 't_loose']);
});
test('rejects unsafe URLs, invalid identities, revisions and future schemas before application', () => {
  for (const mutate of [
    d => { d.schema = 99; },
    d => { d.records.t_first.url.v = 'javascript:alert(1)'; },
    d => { d.records.t_first.url.r = [999, 'device_a']; },
    d => { d.records.t_first.url.r[1] = 'other'; },
    d => { d.records.t_first.placement.v.window = '../../file'; }
  ]) { const doc = start(); mutate(doc); expect(() => validateDocument(doc)).toThrow(); }
});
