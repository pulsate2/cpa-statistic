/**
 * Fallback when ASSETS binding is missing (e.g. partial API deploy).
 * Real deploys via wrangler / GitHub Actions bind web/dist as ASSETS.
 */
export type EmbeddedAsset = {
  contentType: string;
  encoding: "utf8" | "base64";
  body: string;
};

export const EMBEDDED_ASSETS: Record<string, EmbeddedAsset> = {};

export function getEmbeddedAsset(pathname: string): EmbeddedAsset | null {
  if (pathname in EMBEDDED_ASSETS) return EMBEDDED_ASSETS[pathname];
  if (!pathname.startsWith("/api") && !pathname.includes(".")) {
    return EMBEDDED_ASSETS["/index.html"] ?? null;
  }
  return null;
}
