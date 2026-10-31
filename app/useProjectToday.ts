"use client";

import { useEffect, useState } from "react";
import { currentProjectDate, projectDayCheckDelay } from "./projectClock";

/** Updating today must not remount report editors or move an explicitly selected period. */
export function useProjectToday(initialToday: string): string {
  const [today, setToday] = useState(initialToday);
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      window.clearTimeout(timer);
      const now = new Date();
      setToday(currentProjectDate(now));
      timer = window.setTimeout(refresh, projectDayCheckDelay(now));
    };
    const refreshWhenVisible = () => { if (document.visibilityState !== "hidden") refresh(); };
    timer = window.setTimeout(refresh, 0);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);
  return today;
}
