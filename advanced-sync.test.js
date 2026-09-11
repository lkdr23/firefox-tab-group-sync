import { jest } from '@jest/globals';
import {
  getDeviceInfo,
  saveStateToCloud,
  getStorageUsage,
  exportLocalState,
  validateSnapshotData,
  importSnapshotData
} from './background.logic.js';

// Mock utils.js
jest.mock('./utils.js', () => ({
  normalizeUrl: jest.fn((url) => {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      return u.href.replace(/\/$/, "");
    } catch (e) {
      return null;
    }
  }),
  VALID_COLORS: ['blue', 'red', 'green', 'orange', 'yellow', 'purple', 'pink', 'cyan', 'grey'],
  MAX_TITLE_LENGTH: 100,
  compressData: jest.fn(async (obj) => JSON.stringify(obj)),
  decompressData: jest.fn(async (str) => JSON.parse(str)),
}));

if (!global.crypto) {
  global.crypto = {};
}
if (!global.crypto.randomUUID) {
  global.crypto.randomUUID = () => '12345678-1234-1234-1234-1234567890ab';
}

describe('Advanced Sync Features', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    if (!global.browser.tabGroups) {
      global.browser.tabGroups = {
        query: jest.fn(),
        update: jest.fn(),
      };
    }
    if (!global.browser.tabs.group) {
      global.browser.tabs.group = jest.fn();
    }
    if (!global.browser.windows) {
      global.browser.windows = {
        getLastFocused: jest.fn(() => Promise.resolve({ id: 1 })),
      };
    }
  });

  describe('getStorageUsage', () => {
    it('should calculate storage bytes, item count, and percent used', async () => {
      browser.storage.sync.get.mockResolvedValue({
        state_dev1: { timestamp: 123456, groups: [{ title: 'Work', tabs: ['https://example.com'] }] },
        state_dev2: { timestamp: 123457, groups: [{ title: 'Home', tabs: ['https://test.com'] }] }
      });
      browser.storage.sync.QUOTA_BYTES = 102400;
      browser.storage.sync.QUOTA_BYTES_PER_ITEM = 8192;
      browser.storage.sync.MAX_ITEMS = 512;

      const usage = await getStorageUsage();
      expect(usage.itemCount).toBe(2);
      expect(usage.totalBytes).toBeGreaterThan(0);
      expect(usage.quotaBytes).toBe(102400);
      expect(usage.quotaPerItem).toBe(8192);
      expect(usage.maxItems).toBe(512);
      expect(usage.percentUsed).toBeGreaterThanOrEqual(0);
      expect(usage.percentUsed).toBeLessThanOrEqual(100);
      expect(usage.itemSizes).toHaveProperty('state_dev1');
      expect(usage.itemSizes).toHaveProperty('state_dev2');
    });

    it('should handle empty sync storage', async () => {
      browser.storage.sync.get.mockResolvedValue({});
      const usage = await getStorageUsage();
      expect(usage.itemCount).toBe(0);
      expect(usage.totalBytes).toBe(0);
      expect(usage.percentUsed).toBe(0);
    });
  });

  describe('exportLocalState', () => {
    it('should export valid tab groups and device info', async () => {
      browser.storage.local.get.mockResolvedValue({
        device_id: 'test_dev_1',
        device_name: 'Work Laptop'
      });
      browser.tabGroups.query.mockResolvedValue([
        { id: 10, title: 'Project X', color: 'blue' }
      ]);
      browser.tabs.query.mockResolvedValue([
        { id: 101, groupId: 10, url: 'https://github.com/org/repo' },
        { id: 102, groupId: 10, url: 'about:config' } // should be filtered
      ]);

      const exported = await exportLocalState();
      expect(exported.schemaVersion).toBe(1);
      expect(exported.deviceName).toBe('Work Laptop');
      expect(exported.deviceId).toBe('test_dev_1');
      expect(exported.groups.length).toBe(1);
      expect(exported.groups[0].title).toBe('Project X');
      expect(exported.groups[0].color).toBe('blue');
      expect(exported.groups[0].tabs).toEqual(['https://github.com/org/repo']);
    });

    it('should throw error if tabGroups API is missing', async () => {
      const orig = browser.tabGroups;
      delete browser.tabGroups;
      await expect(exportLocalState()).rejects.toThrow('The Tab Groups API is not enabled');
      browser.tabGroups = orig;
    });
  });

  describe('validateSnapshotData', () => {
    it('should validate and normalize well-formed snapshot', () => {
      const input = {
        deviceName: 'Home PC',
        timestamp: 1600000000000,
        groups: [
          {
            title: 'Research',
            color: 'green',
            tabs: ['https://mozilla.org', 'invalid-url', 'https://wikipedia.org/']
          }
        ]
      };

      const result = validateSnapshotData(input);
      expect(result.deviceName).toBe('Home PC');
      expect(result.groups.length).toBe(1);
      expect(result.groups[0].title).toBe('Research');
      expect(result.groups[0].color).toBe('green');
      expect(result.groups[0].tabs).toEqual(['https://mozilla.org', 'https://wikipedia.org']);
    });

    it('should reject invalid snapshot structures', () => {
      expect(() => validateSnapshotData(null)).toThrow();
      expect(() => validateSnapshotData("string")).toThrow();
      expect(() => validateSnapshotData({})).toThrow('missing groups array');
      expect(() => validateSnapshotData({ groups: [] })).toThrow('No valid tab groups found');
    });

    it('should fallback invalid color to grey and sanitize title length', () => {
      const longTitle = 'a'.repeat(200);
      const input = {
        groups: [
          { title: longTitle, color: 'unsupported_color', tabs: ['https://example.com'] }
        ]
      };
      const result = validateSnapshotData(input);
      expect(result.groups[0].color).toBe('grey');
      expect(result.groups[0].title.length).toBe(100);
      expect(result.deviceName).toBe('Imported Device');
    });
  });

  describe('importSnapshotData', () => {
    it('should import valid snapshot into local tab groups', async () => {
      browser.tabGroups.query.mockResolvedValue([]);
      browser.tabs.create.mockResolvedValue({ id: 201 });
      browser.tabs.group.mockResolvedValue(20);
      browser.tabGroups.update.mockResolvedValue({});

      const input = {
        deviceName: 'Friend PC',
        groups: [
          { title: 'Cool Links', color: 'purple', tabs: ['https://developer.mozilla.org'] }
        ]
      };

      const res = await importSnapshotData(input, { saveToSync: false });
      expect(res.groupCount).toBe(1);
      expect(res.tabCount).toBe(1);
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: 'https://developer.mozilla.org',
        active: false
      });
      expect(browser.tabGroups.update).toHaveBeenCalledWith(20, {
        title: 'Cool Links',
        color: 'purple'
      });
    });

    it('should optionally save snapshot to sync storage', async () => {
      browser.tabGroups.query.mockResolvedValue([]);
      browser.tabs.create.mockResolvedValue({ id: 202 });
      browser.tabs.group.mockResolvedValue(21);
      browser.tabGroups.update.mockResolvedValue({});
      browser.storage.sync.set.mockResolvedValue();

      const input = {
        deviceName: 'Saved Device',
        groups: [
          { title: 'Links', color: 'orange', tabs: ['https://example.com'] }
        ]
      };

      await importSnapshotData(input, { saveToSync: true });
      expect(browser.storage.sync.set).toHaveBeenCalled();
      const callArg = browser.storage.sync.set.mock.calls[0][0];
      const key = Object.keys(callArg)[0];
      expect(key).toMatch(/^state_import_/);
    });
  });

  describe('saveStateToCloud Error Tracking', () => {
    it('should record last_sync_error in local storage on failure', async () => {
      browser.storage.local.get.mockResolvedValue({ device_id: 'err_dev' });
      browser.tabGroups.query.mockRejectedValue(new Error('QuotaExceededError: storage limit reached'));

      const res = await saveStateToCloud();
      expect(res).toBeNull();
      expect(browser.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          last_sync_error: expect.stringContaining('QuotaExceededError'),
          last_sync_error_time: expect.any(Number)
        })
      );
    });

    it('should record last_sync_success_time and clear error on successful save', async () => {
      browser.storage.local.get.mockResolvedValue({ device_id: 'ok_dev', device_name: 'Laptop' });
      browser.tabGroups.query.mockResolvedValue([
        { id: 1, title: 'Daily', color: 'blue' }
      ]);
      browser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 1, url: 'https://news.com' }
      ]);
      browser.storage.sync.set.mockResolvedValue();
      browser.storage.sync.get.mockResolvedValue({});

      const count = await saveStateToCloud();
      expect(count).toBe(1);
      expect(browser.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          last_sync_success_time: expect.any(Number)
        })
      );
      expect(browser.storage.local.remove).toHaveBeenCalledWith([
        'last_sync_error',
        'last_sync_error_time'
      ]);
    });
  });
});
