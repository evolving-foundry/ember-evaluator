import type { RunStore } from "../../core/contracts/run-store.js";
import { DirectoryReceiver } from "../../infrastructure/transfer/receiver.js";
import { TransferError, createReceipt } from "../../infrastructure/transfer/protocol.js";

export function createDistributedReceiver(directory: string, store: RunStore): DirectoryReceiver {
  if (!store.importAttempt)
    throw new TransferError("CONFIG_INVALID", "The selected store cannot atomically import remote attempts");
  return new DirectoryReceiver(directory, async (manifest, root) => {
    const accepted = await store.importAttempt!(
      manifest.result,
      { files: manifest.files, missing: manifest.missing },
      root,
    );
    await store.updateRemoteAttempt?.({
      key: manifest.key,
      state: accepted ? "collected" : "quarantined",
      transferId: manifest.transferId,
      receipt: createReceipt(manifest, accepted).receipt,
      message: accepted ? null : "Late attempt evidence retained outside the selected result",
    });
    return accepted;
  });
}
