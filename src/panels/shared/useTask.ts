import { useCallback, useState } from "react";
import { errorMessage } from "../../types/workspace";

/**
 * Runs one async action at a time and keeps its busy and error state, so
 * every panel reports progress and failures the same way.
 */
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, setError };
}
