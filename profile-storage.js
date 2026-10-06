import { SCHEMA, validateDocument } from './profile-model.js';
import { compressData } from './utils.js';

export const PREFIX = 'profile_v1_';
export const LOCAL_KEY = 'profile_sync_v1';
const CHUNK_SIZE = 7000;
const TOTAL_QUOTA = 102400;
const ITEM_QUOTA = 8192;
const bytes = value => new TextEncoder().encode(value).length;
const itemBytes = (key, value) => bytes(key) + bytes(JSON.stringify(value));

async function hash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function decode(data) {
  const binary = atob(data);
  const raw = Uint8Array.from(binary, c => c.charCodeAt(0));
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) throw new Error('Sync document is too large to read safely.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(result));
}
export const defaultCodec = { encode: compressData, decode, hash };

export class ProfileStorage {
  constructor(api, codec = defaultCodec) { this.api = api; this.codec = codec; }
  async usage(data = null) {
    data = data || await this.api.storage.sync.get(null);
    return { bytes: Object.entries(data).reduce((sum, [key, value]) => sum + itemBytes(key, value), 0), limit: TOTAL_QUOTA };
  }
  async read() {
    const data = await this.api.storage.sync.get(null);
    const documents = [];
    for (const [key, head] of Object.entries(data)) {
      if (!key.startsWith(PREFIX) || key.includes(':')) continue;
      if (!head || head.schema !== SCHEMA || typeof head.revision !== 'string' ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(head.revision) || typeof head.hash !== 'string') throw new Error('Unsupported cloud data. Local tabs have been kept.');
      let encoded = head.data;
      if (encoded === undefined) {
        if (!Number.isInteger(head.chunks) || head.chunks < 1 || head.chunks > 32) throw new Error('Invalid cloud chunks.');
        encoded = '';
        for (let i = 0; i < head.chunks; i++) {
          const chunk = data[`${key}:${head.revision}:${i}`];
          if (typeof chunk !== 'string') throw new Error('Waiting for complete cloud data. Use Firefox’s Sync Now, then Save & refresh.');
          encoded += chunk;
        }
      }
      if (typeof encoded !== 'string' || encoded.length > TOTAL_QUOTA || await this.codec.hash(encoded) !== head.hash) {
        throw new Error('Cloud data is incomplete or damaged. Local tabs have been kept.');
      }
      const doc = validateDocument(await this.codec.decode(encoded));
      if (key !== `${PREFIX}${doc.device}`) throw new Error('Cloud writer identity does not match.');
      documents.push(doc);
    }
    return { documents, usage: await this.usage(data) };
  }
  async publish(document) {
    validateDocument(document);
    const encoded = await this.codec.encode(document);
    const key = `${PREFIX}${document.device}`;
    const revision = crypto.randomUUID();
    const head = { schema: SCHEMA, revision, hash: await this.codec.hash(encoded) };
    const staging = {};
    if (encoded.length <= CHUNK_SIZE) head.data = encoded;
    else {
      head.chunks = Math.ceil(encoded.length / CHUNK_SIZE);
      for (let i = 0; i < head.chunks; i++) staging[`${key}:${revision}:${i}`] = encoded.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    }
    const existing = await this.api.storage.sync.get(null);
    // A previous attempt may have staged chunks but failed before publishing
    // its manifest. Reclaim only unreferenced chunks owned by this writer;
    // otherwise repeated retries could fill the quota with orphan revisions.
    const live = existing[key];
    const livePrefix = live?.chunks ? `${key}:${live.revision}:` : null;
    const abandoned = Object.keys(existing).filter(k => k.startsWith(`${key}:`) && (!livePrefix || !k.startsWith(livePrefix)));
    if (abandoned.length && (!live || live.schema === SCHEMA)) {
      await this.api.storage.sync.remove(abandoned);
      abandoned.forEach(k => { delete existing[k]; });
    }
    // Account for both staging and the previous live revision. Never delete the
    // live revision first just to make a write fit; failed saves stay local.
    for (const projected of [{ ...existing, ...staging }, { ...existing, ...staging, [key]: head }]) {
      const entries = Object.entries(projected);
      if (entries.length > 512 || entries.some(([k, v]) => itemBytes(k, v) > ITEM_QUOTA) || entries.reduce((sum, [k, v]) => sum + itemBytes(k, v), 0) > TOTAL_QUOTA) {
        throw new Error('Firefox sync storage is full (100 KB). Your pending changes are saved locally; cloud tabs have not been replaced.');
      }
    }
    if (Object.keys(staging).length) await this.api.storage.sync.set(staging);
    // Publish the manifest last. Readers wait until all referenced chunks exist
    // and their checksum matches, regardless of Firefox Sync delivery order.
    await this.api.storage.sync.set({ [key]: head });
    const stale = Object.keys(existing).filter(k => k.startsWith(`${key}:`) && !k.startsWith(`${key}:${revision}:`));
    if (stale.length) await this.api.storage.sync.remove(stale);
  }
}
