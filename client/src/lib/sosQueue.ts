// Hand-rolled IndexedDB queue for SOS payloads that couldn't reach the network.
// Deliberately not using the `idb` package — this is one object store with
// put/getAll/delete, small enough that a dependency isn't worth it. The
// service worker (client/public/sw.js) opens this exact same DB/store name
// directly (plain JS, can't import this module) for its Background Sync tier.
const DB_NAME = "vibepulse-sos";
const STORE_NAME = "pending";
const DB_VERSION = 1;

export interface QueuedSOSPayload {
  latitude: number | null;
  longitude: number | null;
  locationText: string | null;
  accuracy: number | null;
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

export async function queueSOS(payload: QueuedSOSPayload): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({ payload, queuedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getAllPending(): Promise<Array<{ id: number; payload: QueuedSOSPayload }>> {
  const db = await openDb();
  const result = await new Promise<Array<{ id: number; payload: QueuedSOSPayload }>>((resolve, reject) => {
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

export async function getQueueSize(): Promise<number> {
  return (await getAllPending()).length;
}

// Re-POSTs every queued alert; removes each on success, leaves it queued on
// failure (will retry on the next online event or app open).
export async function flushQueue(post: (payload: QueuedSOSPayload) => Promise<boolean>): Promise<number> {
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
