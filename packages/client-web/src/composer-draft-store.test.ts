import assert from "node:assert/strict";
import test from "node:test";
import {
  readComposerDraft,
  resetComposerDraftStoreForTests,
  subscribeComposerDraft,
  updateSharedComposerDraft,
} from "./composer-draft-store";

test("composer drafts are shared by stable provider session identity", () => {
  resetComposerDraftStoreForTests();
  const key = "codex:provider-session";
  let notifications = 0;
  const unsubscribe = subscribeComposerDraft(key, () => {
    notifications += 1;
  });

  updateSharedComposerDraft(key, "typed in Chat");
  assert.equal(readComposerDraft(key), "typed in Chat");
  assert.equal(notifications, 1);

  updateSharedComposerDraft(key, (current) => `${current}, continued in Canvas`);
  assert.equal(readComposerDraft(key), "typed in Chat, continued in Canvas");
  assert.equal(notifications, 2);

  unsubscribe();
  resetComposerDraftStoreForTests();
});

test("composer drafts remain isolated across sessions", () => {
  resetComposerDraftStoreForTests();
  updateSharedComposerDraft("codex:a", "A");
  updateSharedComposerDraft("codex:b", "B");
  assert.equal(readComposerDraft("codex:a"), "A");
  assert.equal(readComposerDraft("codex:b"), "B");
  resetComposerDraftStoreForTests();
});
