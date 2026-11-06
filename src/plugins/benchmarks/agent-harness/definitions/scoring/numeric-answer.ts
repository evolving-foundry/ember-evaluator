export function normalizeDecimal(value: string): string | null {
  const text = value.trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole = "", fraction = ""] = text.replace(/^[+-]/, "").replaceAll(",", "").split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimal = fraction.replace(/0+$/, "");
  const zero = integer === "0" && !decimal;
  return `${negative && !zero ? "-" : ""}${integer}${decimal ? `.${decimal}` : ""}`;
}

export function compareNumericAnswers(actual: string, expected: string): boolean {
  const a = normalizeDecimal(actual);
  const b = normalizeDecimal(expected);
  return a !== null && b !== null && a === b;
}
