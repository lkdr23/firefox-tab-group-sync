# Privacy Policy for Profile Tab Sync

## Data

When you enable **Sync this profile**, the extension stores HTTP/HTTPS tab URLs, tab/window/group identities, ordering, pinned state, and group names, colours, and collapsed state in Firefox extension sync storage. Firefox transfers that data through the Mozilla account configured in the current profile. Distinct Mozilla accounts have distinct sync data.

Each installation has a random local device identifier used to keep concurrent changes separate. Logical revisions and deletion records support merging and prevent stale devices from reopening closed tabs.

Private browsing windows, popup windows, local files, internal Firefox pages, and extension pages are excluded. The extension does not collect cookies, passwords, page contents, form input, or analytics. Container identities and browsing history are not synchronized. No data is sent to the developer or a third-party server by the extension.

Sync is disabled initially. The checkbox and first-time starting-state choice are kept locally. Unticking pauses further preparation/application of changes; data previously placed in Firefox's sync storage remains available to other participating devices and may still be transferred by Firefox. Firefox, rather than the extension, controls account authentication and cloud-transfer timing.

## Local recovery

Pending edits, persistent session tags, sync bookkeeping, and the last three replacement backups are saved locally. Downloaded backup JSON contains URLs and group names. Local backups are not uploaded. Restoring a backup pauses sync until you explicitly choose a starting state again.

## Permissions

- `tabs`: Read web tab URLs and maintain the shared tab arrangement.
- `tabGroups`: Read and update native group metadata.
- `storage`: Save local state, backups, and account sync documents.
- `sessions`: Attach stable identities to tabs/windows so session restore can retain their identity despite changing native IDs.

The manifest declares `browsingActivity` for Firefox's data-transmission consent because URLs are transferred through Mozilla's sync service. There is no custom login, custom backend, telemetry, or host permission.
