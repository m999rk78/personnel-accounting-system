type EmployeeBitrixStatus = {
  bitrix24Id?: string | null;
  availabilityStatus?: string;
  bitrix24Stage?: string;
  bitrixCheckStatus?: string | null;
  bitrixCheckDetails?: string | null;
  bitrixCheckAcknowledged?: number | boolean;
};

/** Keep a reconciled blacklist stage visible without inventing a mismatch. */
export function employeeBitrixStatus(employee?: EmployeeBitrixStatus) {
  const warning = Boolean(employee?.bitrixCheckStatus && !employee.bitrixCheckAcknowledged);
  if (employee?.availabilityStatus === "blacklisted" || employee?.bitrixCheckStatus === "blacklisted_in_bitrix") return {
    label: "Чёрный список в Битрикс24", tone: "blacklisted", warning,
    details: employee.bitrixCheckDetails || (employee.bitrix24Stage ? `Стадия Битрикс24: ${employee.bitrix24Stage}` : ""),
  };
  if (!employee?.bitrixCheckStatus) return { label: employee && !employee.bitrix24Id ? "Не связан с Битрикс24" : "Нет предупреждений", tone: "neutral", warning: false, details: "" };
  if (employee.bitrixCheckAcknowledged) return { label: "Различия проигнорированы", tone: "acknowledged", warning: false, details: employee.bitrixCheckDetails || "" };
  if (employee.bitrixCheckStatus === "dismissed_in_bitrix") return { label: "Уволен в Битрикс24", tone: "dismissed", warning, details: employee.bitrixCheckDetails || "" };
  if (employee.bitrixCheckStatus === "missing_in_bitrix") return { label: "Отсутствует в Битрикс24", tone: "missing", warning, details: employee.bitrixCheckDetails || "" };
  return { label: "Не совпадает с Битрикс24", tone: "mismatch", warning, details: employee.bitrixCheckDetails || "" };
}
