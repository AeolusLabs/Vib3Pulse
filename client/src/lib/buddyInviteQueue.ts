// Hand-rolled IndexedDB queue for a buddy invite that couldn't reach the
// network — mirrors client/src/lib/sosQueue.ts exactly. Unlike the SOS queue,
// this one only needs a same-session online-event flush (see
// SafetyTriggersProvider.tsx) — no Background Sync tier, since "the app
// reopens later" is an acceptable retry point for a non-emergency invite.
const DB_NAME = "vibepulse-buddy-invite";
const STORE_NAME = "pending";
const DB_VERSION = 1;

export interface QueuedInvitePayload {
  name: string;
  phone_number: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueInvite(payload: QueuedInvitePayload): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({ payload, queuedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getAllPending(): Promise<Array<{ id: number; payload: QueuedInvitePayload }>> {
  const db = await openDb();
  const result = await new Promise<Array<{ id: number; payload: QueuedInvitePayload }>>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function deleteEntry(id: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function flushInviteQueue(post: (payload: QueuedInvitePayload) => Promise<boolean>): Promise<number> {
  const pending = await getAllPending();
  let flushed = 0;
  for (const entry of pending) {
    try {
      const ok = await post(entry.payload);
      if (ok) {
        await deleteEntry(entry.id);
        flushed++;
      }
    } catch {
      // leave it queued, try again next time
    }
  }
  return flushed;
}
