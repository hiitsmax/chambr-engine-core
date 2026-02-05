import type { RoomTextMessage } from "../llm/types";
import type { Roomie } from "../types";
import type { DirectorBeat, TheatricalBudget, TheatricalEvent } from "./types";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const renderXmlTag = (tag: string, value: string) => `<${tag}>${escapeXml(value)}</${tag}>`;

const compact = (value: string) =>
  value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const buildDirectorMessages = (params: {
  userName: string;
  userMessage: string;
  goal?: string;
  summaryWindow: string;
  historyLines: string[];
  roomies: Roomie[];
  presetId: string;
  presetPrompt: string;
  budget: TheatricalBudget;
  maxAgents: number;
}): RoomTextMessage[] => {
  const roomieLines = params.roomies.map((roomie) => {
    const bio = roomie.bio || "";
    return `${roomie.id}: ${roomie.name} - ${bio}`;
  });

  const system = [
    "You are a scene Director for a multi-agent room.",
    "Return ONLY minified JSON object with key beats.",
    "Schema:",
    '{"beats":[{"agent_id":"...","intent":"...","allow_action":true|false,"allow_thought":true|false,"tone_hint":"...","max_events":1-3}]}',
    "Rules:",
    "- Beat-only guidance. Do NOT script final lines.",
    "- Keep events sparse and meaningful.",
    "- Never include narrator/non-roomie agent ids.",
    "- Max beats must be <= maxAgents.",
    "- If unsure, keep allow_action/allow_thought false.",
  ].join("\n");

  const promptBlocks = [
    `PRESET_ID: ${params.presetId}`,
    `PRESET_RULES:\n${params.presetPrompt}`,
    `GOAL: ${params.goal || "(none)"}`,
    `SUMMARY_WINDOW: ${params.summaryWindow || "(none)"}`,
    `MAX_AGENTS: ${params.maxAgents}`,
    `BUDGET: ${JSON.stringify(params.budget)}`,
    "ROOMIES:",
    ...roomieLines,
    params.historyLines.length ? "RECENT_CONTEXT:" : "",
    ...params.historyLines,
    `${params.userName}: ${params.userMessage}`,
  ].filter(Boolean);

  return [
    { role: "system", content: system },
    { role: "user", content: promptBlocks.join("\n") },
  ];
};

export const buildDirectorRepairMessages = (params: {
  raw: string;
  reason: string;
  roomies: Roomie[];
  maxAgents: number;
}): RoomTextMessage[] => {
  const roomieIds = params.roomies.map((roomie) => roomie.id);
  const system = [
    "Repair the JSON output to match the required schema exactly.",
    "Output only one minified JSON object.",
    "Preserve intent but enforce constraints.",
    `Allowed agent_id values: ${roomieIds.join(", ")}`,
    `Max beats: ${params.maxAgents}`,
  ].join("\n");

  const prompt = [
    `Failure reason: ${params.reason}`,
    "Broken payload:",
    params.raw,
    "Return repaired JSON now.",
  ].join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
};

export const buildSpeakerMessages = (params: {
  roomie: Roomie;
  beat: DirectorBeat;
  userMessage: string;
  userName: string;
  goal?: string;
  summaryWindow: string;
  historyLines: string[];
  presetPrompt: string;
  agentMemory?: string[];
}): RoomTextMessage[] => {
  const systemBlocks = [
    "You are the roomie defined below.",
    "Output only NDJSON events; each line is one JSON object.",
    "Allowed types: speak, action, thought.",
    "Schema per line:",
    '{"type":"speak|action|thought","author":"Roomie Name","content":"...","visibility":"public|private","intensity":1-5}',
    "Rules:",
    "- Author must match your roomie name.",
    "- No narrator events.",
    "- Keep output sparse and meaningful.",
    "- Include at least one speak event.",
    params.beat.allowAction ? "- Action allowed." : "- Action not allowed.",
    params.beat.allowThought ? "- Thought allowed only if meaningful voiceover." : "- Thought not allowed.",
    `<preset>${params.presetPrompt}</preset>`,
    `<roomie>${renderXmlTag("id", params.roomie.id)}${renderXmlTag("name", params.roomie.name)}${renderXmlTag("bio", params.roomie.bio || "")}</roomie>`,
    `<beat>${renderXmlTag("beat_id", params.beat.beatId)}${renderXmlTag("intent", params.beat.intent)}${renderXmlTag("tone_hint", params.beat.toneHint || "")}${renderXmlTag("max_events", String(params.beat.maxEvents))}</beat>`,
    `<context>${renderXmlTag("goal", params.goal || "")}${renderXmlTag("summary_window", params.summaryWindow || "")}</context>`,
    params.agentMemory?.length
      ? `<memory>${renderXmlTag("private_notes", params.agentMemory.join(" | "))}</memory>`
      : "",
  ];

  const promptBlocks = [
    params.historyLines.length ? `LAST_MESSAGES:\n${params.historyLines.join("\n")}` : "",
    `${params.userName}: ${params.userMessage}`,
  ].filter(Boolean);

  return [
    { role: "system", content: systemBlocks.join("\n") },
    { role: "user", content: promptBlocks.join("\n\n") },
  ];
};

export const buildSpeakerRepairMessages = (params: {
  raw: string;
  reason: string;
  roomieName: string;
  beatId: string;
  allowAction: boolean;
  allowThought: boolean;
}): RoomTextMessage[] => {
  const system = [
    "Repair malformed NDJSON event output.",
    "Return ONLY NDJSON lines.",
    `author must be exactly: ${params.roomieName}`,
    `beatId should be: ${params.beatId}`,
    params.allowAction ? "action is allowed" : "action is not allowed",
    params.allowThought ? "thought is allowed" : "thought is not allowed",
  ].join("\n");

  const prompt = [
    `Failure reason: ${params.reason}`,
    "Broken output:",
    params.raw,
    "Return valid NDJSON now.",
  ].join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
};

export const buildSummarizerMessagesV3 = (params: {
  userName: string;
  userMessage: string;
  goal?: string;
  summaryWindow: string;
  historyLines: string[];
  meaningfulEvents: TheatricalEvent[];
}): RoomTextMessage[] => {
  const system = [
    "You are a summarizer that compacts room state.",
    "Use only provided facts.",
    "Keep it concise and actionable.",
    "Include: key decisions, commitments, unresolved questions, user intent shifts.",
    "Do not output JSON.",
  ].join("\n");

  const eventLines = params.meaningfulEvents.map((event) => {
    if (event.type === "speak") return `${event.author}: ${event.content}`;
    return `${event.author} (${event.type}): ${event.content}`;
  });

  const prompt = [
    `GOAL: ${params.goal || "(none)"}`,
    `SUMMARY_WINDOW: ${params.summaryWindow || "(none)"}`,
    params.historyLines.length ? "LAST_MESSAGES:" : "",
    ...params.historyLines,
    `NEW_USER_MESSAGE: ${params.userName}: ${params.userMessage}`,
    eventLines.length ? "MEANINGFUL_EVENTS:" : "",
    ...eventLines,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: compact(prompt) },
  ];
};
