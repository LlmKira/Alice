/**
 * 平台命名与跨平台出处（单一归属，ADR-300）：
 * 新增平台只需在这里补一行标签，不再散落在提示词、日记、告警、归档搜索与意愿层各处重复维护。
 */

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  qq: "QQ",
};

/** 从会话 scope 取出平台名（如 "telegram:-1" -> "telegram"，"qq:group:2" -> "qq"）；无前缀返回空串。 */
export function platformOf(scope: string): string {
  const i = scope.indexOf(":");
  return i > 0 ? scope.slice(0, i).toLowerCase() : "";
}

/** 从会话 scope 取出带冒号的平台前缀（如 "qq:group:2" -> "qq:"）；无前缀返回空串。 */
export function platformPrefix(scope: string): string {
  const i = scope.indexOf(":");
  return i > 0 ? scope.slice(0, i + 1) : "";
}

/** 平台名或 scope 对应的展示名（如 "qq" 或 "qq:group:2" -> "QQ"）；未知平台返回 undefined。 */
export function platformLabel(platformOrScope: string): string | undefined {
  const key = platformOrScope.includes(":")
    ? platformOf(platformOrScope)
    : platformOrScope.trim().toLowerCase();
  return Object.hasOwn(PLATFORM_LABELS, key) ? PLATFORM_LABELS[key] : undefined;
}

/** 跨平台记忆出处标签：同一平台或未知时返回空串，不同平台返回 " [Telegram]" / " [QQ]"。 */
export function crossPlatformTag(entryScope: string, hereScope: string | null): string {
  if (hereScope === null) return "";
  const from = platformOf(entryScope);
  const here = platformOf(hereScope);
  if (!from || !here || from === here) return "";
  return ` [${platformLabel(from) ?? from}]`;
}
