import * as path from "node:path";

/**
 * Produces an ES-module-valid specifier (forward slashes, drops the .tsx/.ts
 * extension — rolldown resolves both forms).
 *
 * On Windows, `path.relative()` cannot express a cross-drive path as a
 * relative specifier (e.g. from C:\Temp to F:\project). In that case we fall
 * back to an absolute POSIX-style specifier so rolldown can still resolve the
 * file by its on-disk location.
 */
export function toImportSpecifier(fromDir: string, toFile: string): string {
  const rel = path.relative(fromDir, toFile);
  // path.relative returns the absolute toFile unchanged when it cannot be
  // expressed as a relative path (cross-drive on Windows). Detect this by
  // checking whether the result is still absolute.
  if (path.isAbsolute(rel)) {
    // Use the absolute path directly, normalised to forward slashes.
    return rel.replace(/\\/g, "/").replace(/\.tsx?$/, "");
  }
  const noExt = rel.replace(/\\/g, "/").replace(/\.tsx?$/, "");
  return noExt.startsWith(".") ? noExt : `./${noExt}`;
}
