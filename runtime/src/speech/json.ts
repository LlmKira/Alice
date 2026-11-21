/**
 * 模型原文里的 JSON 对象：正文可能前后带别的字（续写式的想一想），所以取第一个 `{` 到最后一个 `}` 之间；
 * 工具参数（Code Mode 的 run_code arguments）本来就是一整个对象，切出来还是它自己。读不出（或不是对象）返回 null。
 */
export function readObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
