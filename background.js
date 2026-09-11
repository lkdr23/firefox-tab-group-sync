import { normalizeUrl, VALID_COLORS, MAX_TITLE_LENGTH } from './utils.js';
import { getDeviceInfo, saveStateToCloud as saveStateLogic, syncGroupsFromRemote, getStorageUsage, exportLocalState, importSnapshotData } from './background.logic.js';

/**
 * Firefox Tab Group Syncer - Background Script
 * * PREREQUISITE:
 * You must enable 'extensions.tabGroups.enabled' or 'browser.tabs.groups.enabled'
 * in 'about:config' for this to work.
 */

// Global debounce timer to prevent spamming the sync API
let debounceTimer;
let lastAutoSave = Promise.resolve();
let actionStatus = "pending";
const ACTION_ICON_PATHS = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png"
};

const ACTION_STATUS = {
  pending: {
    title: "Sync pending"
  },
  synced: {
    title: "All groups synced"
  },
  error: {
    title: "Sync failed"
  }
};

function setActionStatus(status) {
  actionStatus = status;
  const config = ACTION_STATUS[status] || ACTION_STATUS.pending;
  browser.action.setBadgeText({ text: "" });
  browser.action.setTitle({ title: config.title });
  browser.action.setIcon({ path: ACTION_ICON_PATHS });
}

// --- CORE LOGIC ---

async function saveStateToCloud() {
  try {
    const count = await saveStateLogic();
    if (count !== undefined && count !== null) {
      setActionStatus("synced");
      return count;
    } else {
      setActionStatus("error");
    }
  } catch (error) {
    console.error("Save Error:", error);
    setActionStatus("error");
  }
  return null;
}

// --- SECTION 4: EVENTS & LISTENERS ---

function triggerAutoSave() {
  clearTimeout(debounceTimer);
  setActionStatus("pending");
  lastAutoSave = new Promise((resolve) => {
    debounceTimer = setTimeout(async () => {
      const count = await saveStateToCloud();
      resolve(count);
    }, 2000);
  });
}

// Add listeners to auto-save on any change to tabs or groups.
if (browser.tabGroups) {
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Trigger on page load completion or URL change.
    if (changeInfo.status === 'complete' || changeInfo.url) {
      triggerAutoSave();
    }
  });
  browser.tabs.onMoved.addListener(triggerAutoSave);
  browser.tabs.onRemoved.addListener(triggerAutoSave);
  browser.tabGroups.onUpdated.addListener(triggerAutoSave);
  browser.tabGroups.onCreated.addListener(triggerAutoSave);
  browser.tabGroups.onRemoved.addListener(triggerAutoSave);
}

// Listen for messages from the popup.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "syncGroups" && message.groups) {
    syncGroupsFromRemote(message.groups, { mirror: !!message.mirror })
      .then(() => sendResponse({ status: "success" }))
      .catch((err) => {
        console.error("Sync failed:", err);
        sendResponse({ status: "error", message: err.toString() });
      });
    return true; // Required for async sendResponse.
  }
  if (message.type === "forceSync") {
    saveStateToCloud()
      .then((count) => {
        if (typeof count === 'number') {
          sendResponse({ status: "success", count });
        } else {
          sendResponse({ status: "error", message: "Sync failed." });
        }
      })
      .catch((err) => {
        console.error("Force sync failed:", err);
        sendResponse({ status: "error", message: err.toString() });
      });
    return true; // Required for async sendResponse.
  }
  if (message.type === "waitForAutoSave") {
    lastAutoSave
      .then((count) => {
        if (typeof count === 'number') {
          sendResponse({ status: "success", count });
        } else {
          sendResponse({ status: "error", message: "Auto-sync pending." });
        }
      })
      .catch((err) => {
        console.error("Auto-save check failed:", err);
        sendResponse({ status: "error", message: err.toString() });
      });
    return true; // Required for async sendResponse.
  }
  if (message.type === "getStorageUsage") {
    getStorageUsage()
      .then((usage) => sendResponse({ status: "success", usage }))
      .catch((err) => sendResponse({ status: "error", message: err.toString() }));
    return true;
  }
  if (message.type === "exportLocalState") {
    exportLocalState()
      .then((data) => sendResponse({ status: "success", data }))
      .catch((err) => sendResponse({ status: "error", message: err.toString() }));
    return true;
  }
  if (message.type === "importSnapshot") {
    importSnapshotData(message.data, message.options || {})
      .then((result) => sendResponse({ status: "success", result }))
      .catch((err) => sendResponse({ status: "error", message: err.toString() }));
    return true;
  }
});

// Reactive sync listener: log and track incoming remote sync changes
if (browser.storage && browser.storage.onChanged) {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync") {
      const stateKeys = Object.keys(changes).filter(k => k.startsWith("state_"));
      if (stateKeys.length > 0) {
        console.log("[Background] Storage sync change detected for keys:", stateKeys);
      }
    }
  });
}


// Initial Save on Startup
setActionStatus("pending");
lastAutoSave = saveStateToCloud();
