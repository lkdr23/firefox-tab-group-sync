import { clone, compareRevision, emptyDocument, materialize, mergeDocuments, recordChanges, same, validateDocument } from './profile-model.js';
import { NATIVE_IDS_KEY, ProfileBrowser, appliedBaseline } from './profile-browser.js';
import { LOCAL_KEY, ProfileStorage } from './profile-storage.js';

const emptySnapshot = () => ({ tabs: {}, groups: {} });
const CLOSED_WINDOWS_KEY = 'profile_sync_closed_windows';
function combineWriters(documents) {
  const writers = new Map();
  for (const doc of documents) {
    validateDocument(doc);
    const prior = writers.get(doc.device);
    if (!prior) writers.set(doc.device, clone(doc));
    else {
      const model = mergeDocuments([prior, doc]);
      writers.set(doc.device, { ...emptyDocument(doc.device, model.epoch), clock: model.clock, records: model.records });
    }
  }
  return [...writers.values()];
}

export class ProfileSync {
  constructor(api, { adapter = new ProfileBrowser(api), cloud = new ProfileStorage(api) } = {}) {
    this.api = api;
    this.adapter = adapter;
    this.cloud = cloud;
    this.queue = Promise.resolve();
    this.applying = false;
    this.ready = this.initialize();
  }
  supported() {
    return !!(this.api.tabGroups?.query && this.api.tabs.group && this.api.tabs.ungroup && this.api.sessions?.setTabValue && this.api.sessions?.setWindowValue);
  }
  async initialize() {
    const saved = (await this.api.storage.local.get(LOCAL_KEY))[LOCAL_KEY];
    this.state = saved || {
      device: `dev_${crypto.randomUUID()}`, enabled: false, initialized: false,
      document: null, cache: [], baseline: emptySnapshot(), backups: [], removed: [], pending: false
    };
    await this.persist();
    if (this.api.storage.session) {
      const session = await this.api.storage.session.get([CLOSED_WINDOWS_KEY, NATIVE_IDS_KEY]);
      this.adapter.closedWindows = new Set(session[CLOSED_WINDOWS_KEY] || []);
      const ids = session[NATIVE_IDS_KEY] || {};
      this.adapter.tabIds = new Map(ids.tabs || []);
      this.adapter.windowIds = new Map(ids.windows || []);
      this.adapter.groupIds = new Map(ids.groups || []);
    }
    if (this.supported()) {
      // Reconstruct native-to-logical mappings even when paused, so closes while
      // paused can be merged on resume. Never upload just because we started.
      const captureModel = this.model();
      captureModel.retainIds = new Set(Object.keys(this.state.baseline.tabs));
      try {
        await this.adapter.capture(captureModel);
      } catch (error) {
        // A tab/window can vanish while Firefox is waking the event page. Do
        // not leave `ready` permanently rejected: subsequent events or the
        // Save & refresh button must be able to retry a fresh capture.
        this.state.error = `Could not read the current session: ${error.message || String(error)}. Use Save & refresh to retry.`;
        await this.persist();
      }
    }
  }
  model() {
    return mergeDocuments([...this.state.cache, ...(this.state.document ? [this.state.document] : [])]);
  }
  async persist() { await this.api.storage.local.set({ [LOCAL_KEY]: clone(this.state) }); }
  async backup(snapshot, reason) {
    this.state.backups.unshift({ schema: 1, createdAt: Date.now(), reason, snapshot: clone(snapshot) });
    this.state.backups = this.state.backups.slice(0, 3);
    await this.persist();
  }
  execute(operation) {
    const job = this.queue.then(async () => {
      await this.ready;
      try {
        const result = await operation();
        this.state.error = null;
        await this.persist();
        return result;
      } catch (error) {
        this.state.error = error.message || String(error);
        await this.persist();
        throw error;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  requireSupport() {
    if (!this.supported()) throw new Error('This extension requires desktop Firefox 139 or newer with tab groups enabled.');
  }
  async inspect() {
    await this.ready;
    let cloud = null, cloudError = null, usage = null;
    try {
      const result = await this.cloud.read();
      usage = result.usage;
      const model = mergeDocuments(result.documents);
      if (model.epoch) {
        const snapshot = materialize(model);
        cloud = { tabs: Object.keys(snapshot.tabs).length, groups: new Set(Object.values(snapshot.tabs).map(t => t.placement.group).filter(Boolean)).size };
      }
    } catch (error) {
      cloudError = error.message;
      try { usage = await this.cloud.usage(); } catch (_) { /* unavailable */ }
    }
    return {
      supported: this.supported(), enabled: this.state.enabled, initialized: this.state.initialized,
      pending: this.state.pending, error: this.state.error, cloudError, cloud, usage,
      lastPrepared: this.state.lastPrepared || null, lastReceived: this.state.lastReceived || null,
      backup: this.state.backups[0] ? { createdAt: this.state.backups[0].createdAt, reason: this.state.backups[0].reason } : null
    };
  }
  rememberClose(nativeId, info) {
    // Evaluate immediately: mappings can change before this queued job runs.
    const id = this.adapter.closedTab(nativeId, info);
    if (!id && !info.isWindowClosing) return Promise.resolve();
    return this.execute(async () => {
      await this.persistClosedWindows();
      if (!this.state.initialized) return;
      // Excluded pages and tabs which closed before ever being published do not
      // need tombstones in the cloud.
      if (id && (this.state.baseline.tabs[id] || this.model().records[id]?.url) && !this.state.removed.includes(id)) this.state.removed.push(id);
      await this.persist();
    });
  }
  async persistClosedWindows() {
    if (this.api.storage.session) await this.api.storage.session.set({ [CLOSED_WINDOWS_KEY]: [...this.adapter.closedWindows] });
    await this.adapter.persistNativeMaps();
  }
  async prepareLocal() {
    if (!this.state.document) return;
    const captureModel = this.model();
    // A cloud-closed tab still present in our unapplied baseline is pending
    // removal, not an Undo Close Tab. Preserve its identity across write/apply
    // failures, including background suspension and browser restarts.
    captureModel.retainIds = new Set(Object.keys(this.state.baseline.tabs).filter(id => !this.state.removed.includes(id)));
    // Undo Close Tab can happen before the debounce flush. Give the restored
    // instance a new identity while retaining the old instance's tombstone.
    for (const id of this.state.removed) captureModel.records[id] = { ...captureModel.records[id], deleted: { v: true } };
    const observed = await this.adapter.capture(captureModel);
    const removed = [...this.state.removed, ...observed.excluded.filter(id => this.state.baseline.tabs[id])];
    const result = recordChanges(this.state.document, this.state.baseline, observed.snapshot, removed, this.model().clock);
    this.state.document = result.document;
    this.state.pending ||= result.changed;
    this.state.removed = [];
    this.state.baseline = observed.snapshot;
    // Durable local journal before reading cloud or attempting a quota-limited
    // write. Offline errors and background suspension cannot discard edits.
    await this.persist();
  }
  async publishPending() {
    if (!this.state.pending) return;
    await this.cloud.publish(this.state.document);
    this.state.pending = false;
    this.state.lastPrepared = Date.now();
    await this.persist();
  }
  async finishApply() {
    const plan = this.state.applyPending;
    if (!plan) return;
    this.applying = true;
    try {
      const observed = await this.adapter.apply(plan.snapshot, plan.model, { replace: plan.replace });
      await this.persistClosedWindows();
      this.state.baseline = appliedBaseline(plan.snapshot, observed.snapshot);
      this.state.applyPending = null;
      await this.persist();
    } finally { this.applying = false; }
  }
  refresh() { return this.execute(() => this.cycle()); }
  async cycle() {
    if (!this.state.enabled) return;
    this.requireSupport();
    // Retry an interrupted application before capturing local edits, otherwise
    // its half-created tabs might be mistaken for user changes and uploaded.
    await this.finishApply();
    await this.prepareLocal();
    const incoming = await this.cloud.read();
    const oldEpoch = this.state.document.epoch;
    const changedRemote = !same(combineWriters(this.state.cache), combineWriters(incoming.documents));
    this.state.cache = combineWriters([...this.state.cache, ...incoming.documents]);
    let model = this.model();
    const replace = compareRevision(model.epoch, oldEpoch) > 0;
    if (replace) {
      await this.backup(this.state.baseline, 'Before accepting a new cloud starting state');
      this.state.document = emptyDocument(this.state.device, model.epoch);
      this.state.document.clock = model.clock;
      // Publish our adoption so our obsolete writer data can be replaced by a
      // small document, rather than continuing to consume quota indefinitely.
      this.state.pending = true;
      this.state.removed = [];
      this.state.cache = this.state.cache.filter(doc => doc.device !== this.state.device);
      model = this.model();
    }
    await this.publishPending();
    const snapshot = materialize(model);
    this.state.applyPending = { snapshot, model, replace };
    if (changedRemote && incoming.documents.some(doc => doc.device !== this.state.device)) this.state.lastReceived = Date.now();
    await this.persist();
    await this.finishApply();
  }
  enable(mode) {
    return this.execute(async () => {
      this.requireSupport();
      if (this.state.initialized) {
        this.state.enabled = true;
        await this.persist();
        await this.cycle();
        return;
      }
      if (!['push', 'pull'].includes(mode)) throw new Error('Choose local tabs or cloud tabs for first-time setup.');
      const incoming = await this.cloud.read();
      const remote = mergeDocuments(incoming.documents);
      if (mode === 'pull' && !remote.epoch) throw new Error('No cloud session has arrived yet. Use Firefox’s Sync Now, then Save & refresh, or start with local tabs.');
      const observed = await this.adapter.capture();
      if (mode === 'push') {
        if (remote.epoch) await this.backup(materialize(remote), 'Cloud session before using this device’s tabs');
        const epoch = [Math.max(remote.clock, Date.now()) + 1, this.state.device];
        const result = recordChanges(emptyDocument(this.state.device, epoch), emptySnapshot(), observed.snapshot);
        // An empty session still publishes an epoch, so it is distinguishable
        // from cloud data which has not arrived on this device yet.
        await this.cloud.publish(result.document);
        this.state.document = result.document;
        this.state.baseline = observed.snapshot;
        this.state.lastPrepared = Date.now();
        this.state.cache = incoming.documents.filter(doc => doc.device !== this.state.device);
      } else {
        await this.backup(observed.snapshot, 'Local tabs before replacing with cloud tabs');
        this.state.document = emptyDocument(this.state.device, remote.epoch);
        this.state.document.clock = remote.clock;
        this.state.cache = incoming.documents.filter(doc => doc.device !== this.state.device);
        // If this profile previously contributed, retain its available writer
        // data as well (e.g. after restoring a local backup).
        const own = incoming.documents.find(doc => doc.device === this.state.device);
        if (own) this.state.document = clone(own);
        this.state.applyPending = { snapshot: materialize(remote), model: remote, replace: true };
        this.state.lastReceived = Date.now();
      }
      this.state.enabled = true;
      this.state.initialized = true;
      this.state.pending = false;
      this.state.removed = [];
      await this.persist();
      await this.finishApply();
    });
  }
  disable() {
    return this.execute(async () => {
      // Pausing must always work, including after quota/network/apply failures.
      this.state.enabled = false;
      await this.persist();
    });
  }
  chooseAgain() {
    return this.execute(async () => {
      this.state.enabled = false;
      this.state.initialized = false;
      this.state.applyPending = null;
      await this.persist();
    });
  }
  getBackup() {
    return this.queue.then(async () => {
      await this.ready;
      if (!this.state.backups[0]) throw new Error('No replacement backup is available.');
      return clone(this.state.backups[0]);
    });
  }
  restoreBackup() {
    return this.execute(async () => {
      this.requireSupport();
      if (this.state.applyPending?.operation === 'restore') {
        await this.finishApply();
        this.state.document = null;
        this.state.cache = [];
        this.state.pending = false;
        this.state.removed = [];
        await this.persist();
        return;
      }
      const backup = this.state.backups[0];
      if (!backup) throw new Error('No replacement backup is available.');
      this.state.enabled = false;
      this.state.initialized = false;
      this.state.applyPending = null;
      await this.backup((await this.adapter.capture()).snapshot, 'Before restoring a local backup');
      const model = { records: {} };
      this.state.applyPending = { snapshot: backup.snapshot, model, replace: true, operation: 'restore' };
      await this.persist();
      await this.finishApply();
      this.state.document = null;
      this.state.cache = [];
      this.state.pending = false;
      this.state.removed = [];
      // Leave sync paused; re-enabling explicitly chooses a starting state.
      await this.persist();
    });
  }
}
