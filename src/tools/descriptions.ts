export const TEAMMATE_ID_DESC =
  "The teammate's `uniqueId` (the `uniqueId` field returned by list_teammates) — NOT its display name. " +
  "If the user referred to a teammate by name, FIRST call list_teammates, match the name to its uniqueId, and use that. " +
  "Do NOT ask the user for an id — resolve it yourself via list_teammates.";

export const SUB_AGENT_ID_DESC =
  "The sub-agent teammate's `uniqueId` (from list_teammates), not its name. Resolve names via list_teammates; do not ask the user for an id.";
