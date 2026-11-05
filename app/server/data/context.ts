import { getDatabase } from "../../../db/client";

export const env = { get DB() { return getDatabase(); } };

export type DatabaseExecutor = Pick<ReturnType<typeof getDatabase>, "prepare" | "batch" | "readBatch">;
