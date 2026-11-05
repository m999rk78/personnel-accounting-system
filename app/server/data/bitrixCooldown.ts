import { type Bitrix24Action, bitrix24ActionCooldown, type Bitrix24Cooldowns } from "../../bitrix24Cooldown";
import { env } from "./context";

export type Bitrix24ActionLimitRow = { actionKey: Bitrix24Action; lastStartedAt: string | Date };

export class Bitrix24CooldownError extends Error {
  constructor(readonly cooldown: ReturnType<typeof bitrix24ActionCooldown>) {
    super(`Повторный запрос к Битрикс24 будет доступен через ${Math.max(1, Math.ceil(cooldown.remainingSeconds / 60))} мин.`);
  }
}

export function mapBitrix24Cooldowns(rows: Bitrix24ActionLimitRow[]): Bitrix24Cooldowns {
  const byAction = new Map(rows.map((row) => [row.actionKey, row.lastStartedAt]));
  return {
    inspect: bitrix24ActionCooldown("inspect-bitrix24", byAction.get("inspect-bitrix24")),
    sync: bitrix24ActionCooldown("sync-bitrix24", byAction.get("sync-bitrix24")),
  };
}

export async function reserveBitrix24Action(action: Bitrix24Action) {
  return env.DB.transaction(async (db) => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`personnel-${action}-cooldown`).first();
    const previous = await db.prepare("SELECT last_started_at AS lastStartedAt FROM bitrix24_action_limits WHERE action_key = ?")
      .bind(action).first<{ lastStartedAt: string | Date }>();
    const cooldown = bitrix24ActionCooldown(action, previous?.lastStartedAt);
    if (cooldown.remainingSeconds > 0) throw new Bitrix24CooldownError(cooldown);
    const startedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO bitrix24_action_limits (action_key, last_started_at) VALUES (?, ?)
      ON CONFLICT (action_key) DO UPDATE SET last_started_at = EXCLUDED.last_started_at`).bind(action, startedAt).all();
    return bitrix24ActionCooldown(action, startedAt);
  });
}
