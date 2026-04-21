export const normalizeTextContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeTextContent(entry))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (typeof record.text === "string") {
      return record.text;
    }

    const nestedContent = normalizeTextContent(record.content);
    if (nestedContent) {
      return nestedContent;
    }

    const nestedMessage = normalizeTextContent(record.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
};
