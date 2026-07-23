import assert from "node:assert/strict";
import test from "node:test";
import { preferredStaticContentEncoding } from "./http-server-static";

test("prefers Brotli when both static encodings are equally acceptable", () => {
  assert.equal(preferredStaticContentEncoding("gzip, deflate, br"), "br");
});

test("honors encoding quality and disabled encodings", () => {
  assert.equal(preferredStaticContentEncoding("br;q=0.5, gzip;q=0.9"), "gzip");
  assert.equal(preferredStaticContentEncoding("br;q=0, gzip;q=0"), null);
  assert.equal(preferredStaticContentEncoding("*;q=0.4"), "br");
});

test("does not compress when the request omits Accept-Encoding", () => {
  assert.equal(preferredStaticContentEncoding(undefined), null);
  assert.equal(preferredStaticContentEncoding(["gzip"]), null);
});
