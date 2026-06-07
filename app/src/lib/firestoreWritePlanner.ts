export const FIRESTORE_WRITE_BATCH_SIZE = 200;
export const FIRESTORE_WRITE_PAUSE_MS = 25;

export function chunkFirestoreWrites<T>(items: T[], batchSize = FIRESTORE_WRITE_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

export async function pauseBetweenFirestoreWriteBatches(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, FIRESTORE_WRITE_PAUSE_MS);
  });
}
