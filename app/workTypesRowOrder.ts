export const workTypesOrderScope = "directory-work-types";

export const isWorkTypesOrderId = (id: unknown): id is string => typeof id === "string" && /^(?:parent|child)-[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id.slice(id.indexOf("-") + 1)));

/** Master and detail rows share a scope but retain distinct identities. */
export const workTypesOrderId = (row: { key?: string; kind?: string }): string | undefined => row.kind !== "draft" && isWorkTypesOrderId(row.key) ? row.key : undefined;
