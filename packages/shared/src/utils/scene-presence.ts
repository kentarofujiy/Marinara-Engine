// ──────────────────────────────────────────────
// Scene presence: which group members witness new Roleplay messages
// ──────────────────────────────────────────────

type ScenePresenceChat = {
  mode: string | null | undefined;
  characterIds: readonly string[];
  metadata: Record<string, unknown>;
};

function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && !!id) : [];
}

/**
 * Scene presence only exists in individual-mode group Roleplay, where each turn's audience is one character.
 * Merged mode drops a message for the whole prompt when any active member is excluded, so it never applies there.
 */
export function isScenePresenceActive(chat: ScenePresenceChat): boolean {
  return (
    chat.mode === "roleplay" &&
    chat.characterIds.length > 1 &&
    chat.metadata.groupChatMode === "individual" &&
    chat.metadata.scenePresenceEnabled === true
  );
}

/** Chat members who are not in the scene and therefore must not see messages created now. */
export function resolveSceneAbsentCharacterIds(chat: ScenePresenceChat): string[] {
  if (!isScenePresenceActive(chat)) return [];
  const absent = new Set(readIds(chat.metadata.absentCharacterIds));
  if (chat.metadata.scenePresenceFollowsActivity === true) {
    for (const id of readIds(chat.metadata.inactiveCharacterIds)) absent.add(id);
  }
  return chat.characterIds.filter((id) => absent.has(id));
}

/**
 * Stamp a new message's extra with the current scene: absent members join its per-character hidden list, and
 * members that joined the chat since the last message get their conversation start here.
 */
export function applyScenePresenceToMessageExtra(
  extra: Record<string, unknown>,
  chat: ScenePresenceChat,
  authorCharacterId?: string | null,
): Record<string, unknown> {
  if (!isScenePresenceActive(chat)) return extra;
  const members = new Set(chat.characterIds);
  // A character who speaks while marked absent still knows what they said.
  const absentIds = resolveSceneAbsentCharacterIds(chat).filter((id) => id !== authorCharacterId);
  const joinedIds = readIds(chat.metadata.scenePresencePendingJoinIds).filter((id) => members.has(id));
  if (absentIds.length === 0 && joinedIds.length === 0) return extra;
  const next = { ...extra };
  if (absentIds.length > 0) {
    next.hiddenFromAICharacterIds = Array.from(new Set([...readIds(extra.hiddenFromAICharacterIds), ...absentIds]));
  }
  if (joinedIds.length > 0) {
    next.conversationStartForCharacterIds = Array.from(
      new Set([...readIds(extra.conversationStartForCharacterIds), ...joinedIds]),
    );
  }
  return next;
}
