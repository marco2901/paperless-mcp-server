import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FileLinkStore,
  MAX_OPEN_LINKS,
  filenameFromContentDisposition,
} from "./fileLinks";

test("file link works exactly once", () => {
  const store = new FileLinkStore();
  const token = store.create({ documentId: 2917, original: false });
  assert.ok(token.length >= 40);
  assert.deepEqual(store.consume(token), { documentId: 2917, original: false });
  assert.equal(store.consume(token), undefined);
  assert.equal(store.consume("guessed"), undefined);
});

test("file link expires after its ttl", () => {
  let now = 0;
  const store = new FileLinkStore(() => now);
  const token = store.create({ documentId: 1, original: true }, 600);
  now = 600 * 1000;
  assert.equal(store.consume(token), undefined);
});

test("number of open links is capped", () => {
  const store = new FileLinkStore();
  for (let i = 0; i < MAX_OPEN_LINKS; i++) store.create({ documentId: i, original: false });
  assert.throws(() => store.create({ documentId: 0, original: false }));
});

test("filename prefers the RFC 5987 form sent by Paperless", () => {
  const header =
    "attachment; filename=\"2026-08-05 IONOS Abrechnung.pdf\"; filename*=utf-8''2026-08-05%20IONOS%20Abrechnung%20%C3%84.pdf";
  assert.equal(filenameFromContentDisposition(header, "x"), "2026-08-05 IONOS Abrechnung Ä.pdf");
});

test("filename falls back to plain and default forms", () => {
  assert.equal(filenameFromContentDisposition('inline; filename="a b.pdf"', "x"), "a b.pdf");
  assert.equal(filenameFromContentDisposition("attachment; filename=c.pdf", "x"), "c.pdf");
  assert.equal(filenameFromContentDisposition(undefined, "document-1.pdf"), "document-1.pdf");
});
