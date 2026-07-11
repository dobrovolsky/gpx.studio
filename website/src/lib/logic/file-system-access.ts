import { buildGPX, GPXFile } from 'gpx';
import { db } from '$lib/db';
import { loadFile, fileActions } from '$lib/logic/file-actions';
import {
    fileStateCollection,
    GPXFileStateCollectionObserver,
    type GPXFileState,
} from '$lib/logic/file-state';
import { selection } from '$lib/logic/selection';
import { boundsManager } from '$lib/logic/bounds';
import { i18n } from '$lib/i18n.svelte';
import { toast } from 'svelte-sonner';
import { writable } from 'svelte/store';

export const supportsFileSystemAccess =
    typeof window !== 'undefined' && 'showOpenFilePicker' in window;

type WritableFileHandle = FileSystemFileHandle & {
    requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

const WRITE_DEBOUNCE_MS = 1000;

type LinkedFile = {
    handle: WritableFileHandle;
    unsubscribe: () => void;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    file: GPXFile | null;
    diskSnapshot: string | null;
    skippedInitial: boolean;
    writing: boolean;
    pending: boolean;
};

const linkedFiles = new Map<string, LinkedFile>();
export const liveFileIds = writable(new Set<string>());
const pendingHandles = new Map<string, WritableFileHandle>();

function updateLiveFileIds() {
    liveFileIds.set(new Set(linkedFiles.keys()));
}

async function findExistingLiveFileId(handle: WritableFileHandle): Promise<string | undefined> {
    for (const [fileId, entry] of linkedFiles) {
        if (await handle.isSameEntry(entry.handle)) {
            return fileId;
        }
    }
    for (const [fileId, pending] of pendingHandles) {
        if (await handle.isSameEntry(pending)) {
            return fileId;
        }
    }
    for (const { fileId, handle: persistedHandle } of await db.livefilehandles.toArray()) {
        if (await handle.isSameEntry(persistedHandle)) {
            if (fileStateCollection.getFileState(fileId)) {
                return fileId;
            }
            await forgetHandle(fileId);
        }
    }
    return undefined;
}

async function persistHandle(fileId: string, handle: WritableFileHandle) {
    try {
        await db.livefilehandles.put({ fileId, handle });
    } catch {
        // Some browsers may support the picker but not persisted handles.
    }
}

async function forgetHandle(fileId: string) {
    try {
        await db.livefilehandles.delete(fileId);
    } catch {
        // Ignore storage failures.
    }
}

async function getCurrentFileForReconnect(fileId: string) {
    const loadedFile = fileStateCollection.getFile(fileId);
    if (loadedFile) {
        return loadedFile;
    }

    const storedFile = await db.files.get(fileId);
    return storedFile ? new GPXFile(storedFile) : undefined;
}

async function canReconnectLiveFile(fileId: string, handle: WritableFileHandle) {
    const currentFile = await getCurrentFileForReconnect(fileId);
    if (!currentFile) {
        return false;
    }

    const diskFile = await loadFile(await handle.getFile());
    if (!diskFile) {
        toast.error(`${i18n._('menu.live_open_error', 'Could not open file')}: ${handle.name}`);
        return false;
    }

    if (buildGPX(currentFile, []) !== buildGPX(diskFile, [])) {
        toast.error(
            `${i18n._(
                'menu.live_changed_on_disk',
                'File changed on disk; live editing was not reconnected'
            )}: ${handle.name}`
        );
        return false;
    }

    return true;
}

async function reconnectLiveFile(fileId: string, handle: WritableFileHandle) {
    const fileState = fileStateCollection.getFileState(fileId);
    if (!fileState) {
        await forgetHandle(fileId);
        return false;
    }

    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
        toast.error(
            `${i18n._('menu.live_permission_denied', 'Write permission denied')}: ${handle.name}`
        );
        return false;
    }
    if (!(await canReconnectLiveFile(fileId, handle))) {
        return false;
    }

    await persistHandle(fileId, handle);
    linkFile(fileId, fileState, handle);
    return true;
}

export async function reconnectLiveFiles() {
    if (!supportsFileSystemAccess) {
        return;
    }

    const records = await db.livefilehandles.toArray();
    for (const { fileId, handle } of records) {
        if (linkedFiles.has(fileId)) {
            continue;
        }

        const fileState = fileStateCollection.getFileState(fileId);
        if (!fileState) {
            await forgetHandle(fileId);
            continue;
        }

        const writableHandle = handle as WritableFileHandle;
        try {
            const permission = await writableHandle.queryPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                if (await canReconnectLiveFile(fileId, writableHandle)) {
                    linkFile(fileId, fileState, writableHandle);
                } else {
                    await forgetHandle(fileId);
                }
            }
        } catch {
            await forgetHandle(fileId);
        }
    }
}

new GPXFileStateCollectionObserver(
    (newFiles) => {
        newFiles.forEach((fileState, fileId) => {
            const handle = pendingHandles.get(fileId);
            if (handle) {
                pendingHandles.delete(fileId);
                linkFile(fileId, fileState, handle);
            }
        });
    },
    (fileId) => unlinkFile(fileId),
    () => {}
);

export async function openLiveFiles() {
    if (!supportsFileSystemAccess) {
        return;
    }

    let handles: WritableFileHandle[];
    try {
        handles = await (
            window as unknown as {
                showOpenFilePicker(options?: unknown): Promise<WritableFileHandle[]>;
            }
        ).showOpenFilePicker({
            multiple: true,
            types: [
                {
                    description: 'GPX',
                    accept: { 'application/gpx+xml': ['.gpx'] },
                },
            ],
        });
    } catch {
        return;
    }

    const files = [];
    const usableHandles: WritableFileHandle[] = [];
    for (const handle of handles) {
        try {
            const existingId = await findExistingLiveFileId(handle);
            if (existingId !== undefined) {
                if (!linkedFiles.has(existingId) && !pendingHandles.has(existingId)) {
                    const reconnected = await reconnectLiveFile(existingId, handle);
                    if (!reconnected) {
                        await forgetHandle(existingId);
                        continue;
                    }
                }
                selection.selectFileWhenLoaded(existingId);
                toast.info(
                    `${i18n._('menu.live_already_open', 'File is already open for live editing')}: ${handle.name}`
                );
                continue;
            }
            const permission = await handle.requestPermission({ mode: 'readwrite' });
            if (permission !== 'granted') {
                toast.error(
                    `${i18n._('menu.live_permission_denied', 'Write permission denied')}: ${handle.name}`
                );
                continue;
            }
            const file = await loadFile(await handle.getFile());
            if (file) {
                files.push(file);
                usableHandles.push(handle);
            }
        } catch {
            toast.error(`${i18n._('menu.live_open_error', 'Could not open file')}: ${handle.name}`);
        }
    }

    if (files.length === 0) {
        return;
    }

    const ids = fileActions.addMultiple(files);
    ids.forEach((id, index) => {
        pendingHandles.set(id, usableHandles[index]);
        void persistHandle(id, usableHandles[index]);
    });

    selection.selectFileWhenLoaded(ids[0]);
    boundsManager.fitBoundsOnLoad(ids);
}

function linkFile(fileId: string, fileState: GPXFileState, handle: WritableFileHandle) {
    if (linkedFiles.has(fileId)) {
        return;
    }
    const entry: LinkedFile = {
        handle,
        unsubscribe: () => {},
        debounceTimer: null,
        file: null,
        diskSnapshot: null,
        skippedInitial: false,
        writing: false,
        pending: false,
    };
    entry.unsubscribe = fileState.subscribe((value) => {
        if (value === undefined) {
            return;
        }
        entry.file = value.file;
        if (!entry.skippedInitial) {
            entry.diskSnapshot = buildGPX(value.file, []);
            entry.skippedInitial = true;
            return;
        }
        scheduleWrite(fileId);
    });
    linkedFiles.set(fileId, entry);
    updateLiveFileIds();
}

function unlinkFile(fileId: string, flushPending = true) {
    pendingHandles.delete(fileId);
    const entry = linkedFiles.get(fileId);
    if (!entry) {
        return;
    }
    const hasPendingWrite = entry.debounceTimer !== null || entry.pending;
    if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
    }
    entry.unsubscribe();
    linkedFiles.delete(fileId);
    updateLiveFileIds();
    if (flushPending && hasPendingWrite) {
        void writeFile(fileId, entry);
    }
}

function scheduleWrite(fileId: string) {
    const entry = linkedFiles.get(fileId);
    if (!entry) {
        return;
    }
    if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
    }
    entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        void writeFile(fileId);
    }, WRITE_DEBOUNCE_MS);
}

async function writeFile(fileId: string, entry = linkedFiles.get(fileId)) {
    if (!entry) {
        return;
    }
    if (entry.writing) {
        entry.pending = true;
        return;
    }
    const file = fileStateCollection.getFile(fileId) ?? entry.file;
    if (!file) {
        return;
    }

    entry.writing = true;
    let writable: Awaited<ReturnType<WritableFileHandle['createWritable']>> | undefined;
    try {
        const gpx = buildGPX(file, []);
        const diskFile = await loadFile(await entry.handle.getFile());
        if (!diskFile || buildGPX(diskFile, []) !== entry.diskSnapshot) {
            toast.error(
                `${i18n._(
                    'menu.live_changed_on_disk',
                    'File changed on disk; live editing was not reconnected'
                )}: ${entry.handle.name}`
            );
            await forgetHandle(fileId);
            unlinkFile(fileId, false);
            return;
        }
        writable = await entry.handle.createWritable();
        await writable.write(new Blob([gpx], { type: 'application/gpx+xml' }));
        await writable.close();
        entry.diskSnapshot = gpx;
    } catch {
        try {
            await writable?.abort();
        } catch {
            // Ignore abort failures; the write error below is the actionable one.
        }
        toast.error(
            `${i18n._('menu.live_write_error', 'Could not save to file')}: ${entry.handle.name}`
        );
        await forgetHandle(fileId);
        unlinkFile(fileId, false);
        return;
    } finally {
        entry.writing = false;
    }

    if (entry.pending) {
        entry.pending = false;
        void writeFile(fileId, entry);
    }
}
