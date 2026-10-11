/** A JSON encoding that does not depend on key order. PostgreSQL's jsonb
 *  stores an object's keys sorted by length, then bytes, so a package read
 *  back from `theme_releases` or `theme_studio_versions` has its keys in a
 *  different order from the one that was written: any `JSON.stringify`
 *  comparison, digest or equality test over stored data is wrong exactly
 *  once it leaves the process that built it. Undefined members are dropped
 *  the way JSON.stringify drops them. Dependency-free, so the theme
 *  contracts (`lib/themes/*`) and the Studio contract can share one copy
 *  without a cycle. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? "null" : canonicalJson(item)))
      .join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Structural equality over JSON values, whatever order their keys arrived in. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
