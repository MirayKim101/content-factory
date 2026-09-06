export function normalizeMultipartFilename(filename: string): string {
  if ([...filename].some((character) => character.codePointAt(0)! > 255))
    return filename;
  const decoded = Buffer.from(filename, "latin1").toString("utf8");
  if (decoded.includes("\uFFFD")) return filename;
  return Buffer.from(decoded, "utf8").toString("latin1") === filename
    ? decoded
    : filename;
}
