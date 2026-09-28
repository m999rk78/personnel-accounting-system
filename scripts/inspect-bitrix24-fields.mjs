import process from "node:process";

const webhook = process.env.BITRIX24_WEBHOOK_URL?.trim();
const entityTypeId = Number(process.env.BITRIX24_EMPLOYEE_ENTITY_TYPE_ID ?? 182);

if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL не задан.");
if (!Number.isInteger(entityTypeId) || entityTypeId < 128) throw new Error("Некорректный BITRIX24_EMPLOYEE_ENTITY_TYPE_ID.");

const endpoint = new URL("crm.item.fields.json", webhook.endsWith("/") ? webhook : `${webhook}/`);
if (endpoint.protocol !== "https:") throw new Error("Вебхук Битрикс24 должен использовать HTTPS.");

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ entityTypeId, useOriginalUfNames: "N" }),
});
const payload = await response.json();
if (!response.ok || payload.error) throw new Error(payload.error_description ?? payload.error ?? `HTTP ${response.status}`);

const fields = payload?.result?.fields ?? payload?.result ?? {};
const catalog = Object.entries(fields).map(([code, definition]) => ({
  code,
  title: definition?.title ?? definition?.formLabel ?? definition?.listLabel ?? "",
  type: definition?.type ?? "",
  multiple: Boolean(definition?.isMultiple ?? definition?.multiple),
  values: Array.isArray(definition?.items)
    ? definition.items.map((item) => String(item?.VALUE ?? item?.value ?? item?.NAME ?? item?.name ?? "").trim()).filter(Boolean)
    : [],
}));

const likelyEmployeeFields = catalog.filter((field) =>
  /фио|сотруд|тип|отдел|подраздел|должност|професс|объект|проект|стади/i.test(`${field.title} ${field.code}`),
);

console.log(JSON.stringify({
  ok: true,
  portal: endpoint.hostname,
  entityTypeId,
  fieldCount: catalog.length,
  likelyEmployeeFields,
}, null, 2));
