/**
 * App-level timers hook
 * - Spinner animation (only when waiting)
 * - Buffer display tick (during streaming)
 */

import { useEffect, useState } from "react";
import type { AppState } from "../types.js";

export interface UseAppTimersResult {
  spinnerFrame: number;
  bufferTick: number;
}

interface UseAppTimersOptions {
  appState: AppState;
  isWaiting: boolean;
}

export function useAppTimers({ appState, isWaiting }: UseAppTimersOptions): UseAppTimersResult {
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [, setBufferTick] = useState(0);

  // Spinner animation — only when waiting
  useEffect(() => {
    if (!isWaiting) return;
    const id = setInterval(() => setSpinnerFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, [isWaiting]);

  // Buffer display tick — during streaming
  useEffect(() => {
    if (appState !== "streaming" || isWaiting) return;
    const id = setInterval(() => setBufferTick((n) => n + 1), 400);
    return () => clearInterval(id);
  }, [appState, isWaiting]);

  return {
    spinnerFrame,
    bufferTick: 0, // Internal state, not needed externally
  };
}
