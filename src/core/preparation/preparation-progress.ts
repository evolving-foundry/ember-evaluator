import type { EnvironmentImageReady } from "../contracts/environment.js";
import type { ProgressListener } from "../progress/progress.js";

export function imagePreparationProgress(
  taskId: string,
  purpose: "solve" | "verify",
  onProgress?: ProgressListener,
): (timing: EnvironmentImageReady) => void {
  return timing => {
    const sources = {
      built: "new build", image: "existing image", memory: "in-process cache", shared: "shared build result", reference: "explicit image reference",
    };
    const state = timing.cache === "built" ? "Task image build completed" : "Task image ready";
    onProgress?.({ phase: "prepare", taskId,
      message: `${state}; purpose=${purpose}; elapsed ${(timing.imageMs / 1000).toFixed(1)}s; source=${timing.cache === undefined ? "unknown" : sources[timing.cache]}`,
    });
  };
}
