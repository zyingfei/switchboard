export interface WaitForCompletionOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export const waitForCompletion = async (
  detectCompletion: () => Promise<boolean>,
  { intervalMs = 50, timeoutMs = 2_000 }: WaitForCompletionOptions = {},
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await detectCompletion()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  return false;
};
