import assert from "node:assert/strict";
import test from "node:test";

import { bitrix24ActionCooldown, bitrix24Cooldown, formatBitrix24Cooldown, remainingBitrix24Cooldown } from "../app/bitrix24Cooldown.ts";

test("Bitrix24 checks are temporarily available without a cooldown", () => {
  const startedAt = "2026-09-27T12:00:00.000Z";
  assert.deepEqual(bitrix24ActionCooldown("inspect-bitrix24", startedAt, Date.parse("2026-09-27T13:00:00.000Z")), {
    nextAllowedAt: "2026-09-27T12:00:00.000Z",
    remainingSeconds: 0,
  });
  assert.equal(bitrix24ActionCooldown("inspect-bitrix24", startedAt, Date.parse("2026-09-27T14:00:00.000Z")).remainingSeconds, 0);
  assert.equal(bitrix24ActionCooldown("sync-bitrix24", startedAt, Date.parse("2026-09-27T13:00:00.000Z")).remainingSeconds, 3600);
  assert.equal(bitrix24Cooldown(startedAt, Date.parse("2026-09-27T13:00:00.000Z")).remainingSeconds, 3600);
  assert.equal(remainingBitrix24Cooldown("2026-09-27T14:00:00.000Z", Date.parse("2026-09-27T13:00:00.000Z")), 3600);
});

test("Bitrix24 cooldown text is concise", () => {
  assert.equal(formatBitrix24Cooldown(7140), "1 ч 59 мин");
  assert.equal(formatBitrix24Cooldown(30), "меньше минуты");
  assert.equal(formatBitrix24Cooldown(0), "");
});
