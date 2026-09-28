export const BITRIX24_ACTION_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export type Bitrix24Action = "inspect-bitrix24" | "sync-bitrix24";
export type Bitrix24Cooldown = { nextAllowedAt: string | null; remainingSeconds: number };
export type Bitrix24Cooldowns = { inspect: Bitrix24Cooldown; sync: Bitrix24Cooldown };

export function bitrix24Cooldown(lastStartedAt: string | Date | null | undefined, now = Date.now()): Bitrix24Cooldown {
  if (!lastStartedAt) return { nextAllowedAt: null, remainingSeconds: 0 };
  const startedAt = new Date(lastStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return { nextAllowedAt: null, remainingSeconds: 0 };
  const nextAllowed = startedAt + BITRIX24_ACTION_COOLDOWN_MS;
  return {
    nextAllowedAt: new Date(nextAllowed).toISOString(),
    remainingSeconds: Math.max(0, Math.ceil((nextAllowed - now) / 1000)),
  };
}

export function formatBitrix24Cooldown(seconds: number) {
  if (seconds <= 0) return "";
  if (seconds < 60) return "меньше минуты";
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (!hours) return `${minutes} мин`;
  return restMinutes ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
}

export function remainingBitrix24Cooldown(nextAllowedAt: string | null | undefined, now = Date.now()) {
  if (!nextAllowedAt) return 0;
  const deadline = new Date(nextAllowedAt).getTime();
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}
