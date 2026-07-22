import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isTransportErrorMessage } from "./transport-error";

describe("transport error classification", () => {
  test("recognizes browser and iOS network failures", () => {
    assert.equal(isTransportErrorMessage("Load failed"), true);
    assert.equal(
      isTransportErrorMessage("The Internet connection appears to be offline."),
      true,
    );
    assert.equal(
      isTransportErrorMessage("A server with the specified hostname could not be found."),
      true,
    );
    assert.equal(isTransportErrorMessage("The network connection was lost."), true);
  });

  test("recognizes transient HTTP gateway failures", () => {
    assert.equal(isTransportErrorMessage("Request failed: 502 Bad Gateway"), true);
    assert.equal(isTransportErrorMessage("Request failed: 503 Service Unavailable"), true);
    assert.equal(isTransportErrorMessage("Request failed: 504 Gateway Timeout"), true);
  });

  test("does not hide real operation failures as reconnecting", () => {
    assert.equal(isTransportErrorMessage("Max payload size exceeded"), false);
    assert.equal(
      isTransportErrorMessage("ephemeral thread does not support goals"),
      false,
    );
    assert.equal(isTransportErrorMessage("Model not found: fake/model"), false);
  });
});
