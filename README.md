# Profile Tab Sync (Firefox)

A fork of [Tab Group Syncer](https://github.com/sudhir-asuracore/firefox-tab-group-sync) that automatically synchronizes a profile's web tabs and native tab groups through Mozilla's built-in extension sync storage.

Enable one checkbox on each participating desktop Firefox profile. Devices share a session through the Mozilla account; you do not select another device to sync from. Work and personal profiles using different Mozilla accounts stay separate.

## Setup

1. Use desktop Firefox **139 or newer**, with native tab groups enabled.
2. Sign into the same Mozilla account on the devices that should share tabs. Enable **Add-ons** in Firefox Settings → Sync.
3. Install this fork on each device using the **same add-on ID**.
4. On the first device, open the extension, tick **Sync this profile**, choose **Use this device's tabs**, and click **Enable sync**. This establishes the starting session for that account, replacing any previously established session for this fork.
5. Run **Firefox account menu → Sync Now** on the sending and receiving devices, or wait for Firefox's scheduled sync.
6. On the other devices, tick the checkbox and choose **Use cloud tabs on this device**. Their local web tabs will be replaced after a local recovery backup is saved.

If no cloud session has arrived, the cloud choice stays unavailable. **Save & refresh** rechecks data already delivered to this device. It cannot force a network transfer: use Firefox's own **Sync Now** command for that.

The checkbox is local to each profile. Unticking pauses uploads and automatic application and keeps your tabs. Re-enabling resumes and merges observed local changes with received remote changes.

## What syncs

- All open HTTP/HTTPS tabs, including ungrouped tabs and duplicate URLs.
- Tab ordering, pinned state, and normal window placement.
- Group membership, names, colours, and collapsed state. Same-name groups remain distinct.
- New tabs, URL changes, movement, and explicit tab closures.

Private browsing windows, popup windows, local files, internal Firefox pages, and extension pages stay local. The “private” profile can sync its ordinary windows; this exclusion refers to Firefox's private browsing mode. Cookies, login sessions, page contents, form input, tab back/forward history, container identities, and active-tab/focus selection are not synchronized. Remote tabs open in the receiving profile's default container.

Closing a whole window preserves its tabs in the shared session and does not reopen that window during the current browser session. This also applies when closing the last tab closes its window: Firefox reports it as a window closure. On a subsequent startup the shared session can be recreated. Close individual tabs while keeping their window open to remove them across devices. Firefox may still be restoring a session at startup, so missing startup tabs are never treated as deletions.

## Recovery

Before replacement, the extension saves a local recovery snapshot. The last three backups are retained in `storage.local`, outside the cloud quota. In **Recovery & scope**:

- **Download latest backup** saves a JSON copy.
- **Restore backup locally…** restores that snapshot, saves a backup of the current web tabs, and pauses sync. Re-enable to choose whether the restored tabs or cloud tabs should be the new starting state.
- **Choose starting tabs again…** pauses sync and shows the initial choices again. Choosing local tabs establishes a new starting session for all participating devices. Offline edits to an older starting session are superseded, with a local backup when those devices receive the replacement.

Keep the backup JSON private: URLs and group names may contain sensitive information. Backups do not preserve authentication, unsaved form input, containers, or page history.

## Storage and transfer

Firefox documents extension sync transfers approximately every **10 minutes**, or when you use its **Sync Now** command. **Save & refresh** flushes pending local changes and applies complete remote data already available locally. “Changes saved for sync” is a local preparation timestamp, not confirmation of delivery to another device.

Firefox allows **100 KB total**, **8 KB per item**, and **512 items**, shared across the extension's devices within each account. Documents are gzip compressed and larger documents are split into revision-specific chunks. The popup shows actual quota usage. Incomplete chunks or failed checksums postpone application without replacing tabs. Quota failures keep pending changes in a durable local journal for retry.

Each device exclusively writes its own cloud document, containing the latest fields it changed. Merges use logical revisions per field. Concurrent edits to different tabs or fields are retained; conflicts on the same field have a deterministic winner. Deletion wins over edits to that tab's identity. Reopening/Undo Close Tab creates a fresh identity, so stale devices cannot resurrect a closed tab. No device-selection interface is needed.

Deletion records are retained to protect against offline devices. Storage is not an unlimited archive: heavy long-term tab churn can fill the quota. Explicitly choosing the current local tabs as a new starting session compacts that device's history; other devices compact their obsolete documents when they receive the new session. Keep recovery copies before doing this because pending edits from the previous starting session are superseded.

## Install for local testing

```sh
npm ci
npm test -- --runInBand
npm run build
```

In `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on…** and choose `manifest.json` or `tab-group-sync.zip`. Temporary installations are removed on browser restart. For permanent installation on standard Firefox, submit/sign the fork through Mozilla Add-ons (listed or unlisted), then install the signed package on each device. The generated ZIP is **unsigned**; building it is not publication or signing.

This fork uses `profile-sync@firefox-tab-group-sync`, separate from the upstream `support@sudhirnakka.com`, so it neither reads nor overwrites the original add-on's snapshots. Disable the original add-on while testing to avoid two extensions modifying groups. Start with local tabs on one authoritative device; existing upstream snapshots are not automatically migrated.

## Development

Node.js 18+ is required. Tests cover three independent device replicas, concurrent/offline changes, native session ID changes, backups, interruption/retry, checksum and quota failures, and pause/resume. `profile-model.js` contains the merge rules; `profile-browser.js` bridges native Firefox sessions; `profile-storage.js` manages cloud encoding; `profile-sync.js` coordinates serialized, locally journaled operations. The legacy snapshot helpers remain in source for their existing compatibility tests but are not used by the new background or popup.

Real account-to-account cloud transport must be checked with signed-in Firefox profiles; automated tests simulate that transport. Firefox's sync backend handles account authentication and scheduling.

## Privacy and license

See [PRIVACY.md](PRIVACY.md). No custom backend, telemetry, or third-party service is used. Firefox's installation prompt declares browsing activity because tab URLs are transferred through your Mozilla account after you opt into sync.

MIT. Original project © Sudhir Babu Nakka. See [LICENSE](LICENSE).
