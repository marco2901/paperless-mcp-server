import { randomBytes } from "node:crypto";

/**
 * Short-lived single-use download links for Paperless documents.
 *
 * Lets another server (e.g. the OneDrive upload of the M365 MCP via `sourceUrl`,
 * or HERO) fetch a document itself, so the bytes never have to pass through the
 * chat as base64. Tokens are random (256 bit), expire after a few minutes and
 * work for exactly one fetch. They live in memory only; a restart drops them.
 */

export const FILES_ROUTE = "/files/";
export const DEFAULT_TTL_SECONDS = 600;
export const MAX_OPEN_LINKS = 200;

export interface FileLinkTarget {
  documentId: number;
  original: boolean;
}

interface FileLink extends FileLinkTarget {
  expiresAt: number;
}

export class FileLinkStore {
  private links = new Map<string, FileLink>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private purge(now: number) {
    for (const [token, link] of this.links) {
      if (link.expiresAt <= now) this.links.delete(token);
    }
  }

  create(target: FileLinkTarget, ttlSeconds = DEFAULT_TTL_SECONDS): string {
    const now = this.now();
    this.purge(now);
    if (this.links.size >= MAX_OPEN_LINKS) {
      throw new Error("Too many open download links. Please wait a few minutes.");
    }
    const token = randomBytes(32).toString("base64url");
    this.links.set(token, { ...target, expiresAt: now + ttlSeconds * 1000 });
    return token;
  }

  /** Returns the target exactly once; unknown or expired tokens yield undefined. */
  consume(token: string): FileLinkTarget | undefined {
    this.purge(this.now());
    const link = this.links.get(token);
    if (!link) return undefined;
    this.links.delete(token);
    return { documentId: link.documentId, original: link.original };
  }
}

export const fileLinks = new FileLinkStore();

/**
 * Extracts the filename from a Content-Disposition header. Prefers the RFC 5987
 * `filename*=utf-8''…` form (Paperless sends both), falls back to `filename="…"`.
 */
export function filenameFromContentDisposition(
  header: string | undefined | null,
  fallback: string
): string {
  if (!header) return fallback;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1])?.trim();
  return name || fallback;
}
