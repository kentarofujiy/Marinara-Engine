import assert from "node:assert/strict";
import {
  applyScenePresenceToMessageExtra,
  isScenePresenceActive,
  resolveSceneAbsentCharacterIds,
} from "../../packages/shared/src/utils/scene-presence.js";
import { filterPromptMessagesForCharacterAudience } from "../../packages/server/src/services/generation/prompt-message-scope.js";
import { resolveConversationConnectedChatContext } from "../../packages/server/src/routes/generate/conversation-connected-context.js";

const members = ["ann", "bob", "cat"];
const chat = (metadata: Record<string, unknown>, mode = "roleplay", characterIds = members) => ({
  mode,
  characterIds,
  metadata: { groupChatMode: "individual", scenePresenceEnabled: true, ...metadata },
});

// Only individual-mode group Roleplay with the toggle on.
assert.equal(isScenePresenceActive(chat({})), true);
assert.equal(isScenePresenceActive(chat({ groupChatMode: "merged" })), false, "merged mode never applies");
assert.equal(isScenePresenceActive(chat({ scenePresenceEnabled: false })), false, "off by default");
assert.equal(isScenePresenceActive(chat({}, "conversation")), false);
assert.equal(isScenePresenceActive(chat({}, "roleplay", ["ann"])), false, "single-character chats have no scene");
assert.deepEqual(
  applyScenePresenceToMessageExtra({ note: 1 }, chat({ scenePresenceEnabled: false, absentCharacterIds: ["bob"] })),
  { note: 1 },
  "inactive presence leaves extra untouched",
);

// Absent set: manual list, optionally plus disabled members; non-members ignored.
assert.deepEqual(resolveSceneAbsentCharacterIds(chat({ absentCharacterIds: ["bob", "ghost"] })), ["bob"]);
assert.deepEqual(resolveSceneAbsentCharacterIds(chat({ absentCharacterIds: [], inactiveCharacterIds: ["cat"] })), []);
assert.deepEqual(
  resolveSceneAbsentCharacterIds(
    chat({ absentCharacterIds: ["bob"], inactiveCharacterIds: ["cat"], scenePresenceFollowsActivity: true }),
  ),
  ["bob", "cat"],
);

// Stamping merges with existing visibility and stamps pending joiners' conversation start.
const stamped = applyScenePresenceToMessageExtra(
  { hiddenFromAICharacterIds: ["ann"], conversationStartForCharacterIds: ["ann"] },
  chat({ absentCharacterIds: ["bob", "ann"], scenePresencePendingJoinIds: ["cat", "ghost"] }),
);
assert.deepEqual(stamped.hiddenFromAICharacterIds, ["ann", "bob"]);
assert.deepEqual(stamped.conversationStartForCharacterIds, ["ann", "cat"]);

assert.deepEqual(
  applyScenePresenceToMessageExtra({}, chat({ absentCharacterIds: ["bob", "cat"] }), "bob").hiddenFromAICharacterIds,
  ["cat"],
  "a message is never hidden from its own author",
);

// The stamp is what the existing per-turn prompt filter already honours.
const history = [
  { role: "system" as const, content: "Rules" },
  { id: "m1", role: "user" as const, content: "Before bob left", contextKind: "history" as const },
  {
    id: "m2",
    role: "user" as const,
    content: "While bob was away",
    contextKind: "history" as const,
    hiddenFromAICharacterIds: resolveSceneAbsentCharacterIds(chat({ absentCharacterIds: ["bob"] })),
  },
  { id: "m3", role: "user" as const, content: "Bob is back", contextKind: "history" as const },
];
const forBob = JSON.stringify(filterPromptMessagesForCharacterAudience(history, ["bob"]));
assert.ok(forBob.includes("Before bob left") && forBob.includes("Bob is back"));
assert.ok(!forBob.includes("While bob was away"), "absent character must not see scene messages");
assert.ok(JSON.stringify(filterPromptMessagesForCharacterAudience(history, ["ann"])).includes("While bob was away"));

// A mid-chat joiner sees nothing before their conversation start.
const joined = [
  { id: "m1", role: "user" as const, content: "Old scene", contextKind: "history" as const },
  {
    id: "m2",
    role: "user" as const,
    content: "Cat arrives",
    contextKind: "history" as const,
    conversationStartForCharacterIds: ["cat"],
  },
];
const forCat = JSON.stringify(filterPromptMessagesForCharacterAudience(joined, ["cat"]));
assert.ok(!forCat.includes("Old scene") && forCat.includes("Cat arrives"));

// A connected conversation reads the roleplay with the same visibility rules.
const rpMessages = [
  ...Array.from({ length: 25 }, (_, index) => ({ id: `old${index}`, role: "user", content: `Filler ${index}` })),
  { id: "g", role: "user", content: "Global secret", extra: { hiddenFromAI: true } },
  {
    id: "b",
    role: "assistant",
    characterId: "ann",
    content: "Scene without bob",
    extra: { hiddenFromAICharacterIds: ["bob"] },
  },
  { id: "c", role: "assistant", characterId: "ann", content: "Command anchor", extra: { commandOnly: true } },
  ...Array.from({ length: 19 }, (_, index) => ({ id: `new${index}`, role: "user", content: `Recent ${index}` })),
];
const connectedBlockFor = async (audienceCharacterIds: string[]) =>
  (
    await resolveConversationConnectedChatContext({
      connectedChatId: "rp",
      conversationCommandsEnabled: false,
      chatMeta: {},
      personaName: "User",
      chats: {
        getById: async () => ({ id: "rp", name: "RP", mode: "roleplay", characterIds: ["ann", "bob"] }),
        listMessages: async () => rpMessages,
      },
      chars: { getById: async (id: string) => ({ data: JSON.stringify({ name: id }) }) },
      gameStateStore: { getLatestCommitted: async () => null, getLatest: async () => null },
      wrapFormat: "xml",
      audienceCharacterIds,
    })
  ).connectedChatBlock ?? "";
const bobBlock = await connectedBlockFor(["bob"]);
assert.ok(!bobBlock.includes("Global secret") && !bobBlock.includes("Command anchor"));
assert.ok(!bobBlock.includes("Scene without bob"), "connected chat must honour per-character hiding");
assert.ok(bobBlock.includes("Filler 24") && !bobBlock.includes("Filler 23"), "window refills to 20 visible messages");
const annBlock = await connectedBlockFor(["ann"]);
assert.ok(annBlock.includes("Scene without bob") && !annBlock.includes("Global secret"));
// The shared group excerpt is the strictest view; Individual responders get their own rebuild (ann's block above).
const groupBlock = await connectedBlockFor(["ann", "bob"]);
assert.ok(!groupBlock.includes("Scene without bob"), "shared excerpt hides what any member missed");
assert.notEqual(groupBlock, annBlock, "per-responder excerpt differs from the shared one");

console.log("scene presence regression passed");
