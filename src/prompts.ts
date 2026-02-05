import type { SharedState, SpeakerOutput } from "./types";

type SimplePrompt = {
  system: string;
  prompt: string;
};

const stringifyCompact = (value: unknown) => JSON.stringify(value, null, 0);

const renderShared = (shared: SharedState) =>
  [
    `TURN_INDEX: ${shared.turn_index}`,
    `GOAL: ${shared.goal || ""}`,
    `SUMMARY_WINDOW: ${shared.summary_window || ""}`,
  ].join("\n");

const renderTurnOutputs = (outputs: SpeakerOutput[]) =>
  stringifyCompact(
    outputs.map((output) => ({
      agent_id: output.agent_id,
      intent: output.intent,
      text: output.text,
    }))
  );

const resolveAuthorName = (message: SharedState["last_messages"][number], params: { userName: string; agentNames: Map<string, string> }) => {
  if (message.role === "user") return params.userName;
  if (message.agent_id) return params.agentNames.get(message.agent_id) || "Agent";
  return "Agent";
};

const renderLastMessageLines = (shared: SharedState, params: { userName: string; agentNames: Map<string, string> }) => {
  if (!shared.last_messages.length) return [];
  return shared.last_messages.map((message) => {
    const author = resolveAuthorName(message, params);
    return `${author}: ${message.text}`;
  });
};

const renderLastMessages = (shared: SharedState, params: { userName: string; agentNames: Map<string, string> }) =>
  renderLastMessageLines(shared, params).join("\n");

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const renderXmlTag = (tag: string, value: string) => `<${tag}>${escapeXml(value)}</${tag}>`;

const renderAgentPropsXml = (agent: {
  id: string;
  name: string;
  bio: string;
  role?: string | null;
  outputStyle?: string | null;
}) => {
  const lines = [
    "<system>",
    "  <id>speaker.agent_props</id>",
    "  <agent_props>",
    `    ${renderXmlTag("agent_id", agent.id)}`,
    `    ${renderXmlTag("agent_name", agent.name)}`,
    `    ${renderXmlTag("agent_bio", agent.bio)}`,
    `    ${renderXmlTag("output_style", agent.outputStyle ?? "")}`,
    "  </agent_props>",
    "</system>",
  ];
  return lines.join("\n");
};

const renderSpeakerRuntimeXml = (params: { intent?: string }) => {
  const lines = ["<system>", "  <id>speaker.runtime</id>"];
  if (params.intent) {
    lines.push(`  ${renderXmlTag("intent", params.intent)}`);
  }
  lines.push("</system>");
  return lines.join("\n");
};

const renderSpeakerContextXml = (params: {
  roomies?: { name: string; bio: string }[];
  shared?: SharedState;
  turnOutputs?: SpeakerOutput[];
  agentMemory?: string[];
}) => {
  const lines = ["<system>", "  <id>speaker.context</id>"];
  if (params.roomies) {
    lines.push(`  ${renderXmlTag("roomies_json", stringifyCompact(params.roomies))}`);
  }
  if (params.shared) {
    lines.push(`  ${renderXmlTag("shared", renderShared(params.shared))}`);
  }
  if (params.agentMemory && params.agentMemory.length) {
    lines.push(`  ${renderXmlTag("agent_memory_json", stringifyCompact(params.agentMemory))}`);
  }
  if (params.turnOutputs && params.turnOutputs.length) {
    lines.push(`  ${renderXmlTag("turn_outputs", renderTurnOutputs(params.turnOutputs))}`);
  }
  lines.push("</system>");
  return lines.join("\n");
};

const renderSpeakerGuardrailsXml = () =>
  [
    "<system>",
    "  <id>speaker.guardrails</id>",
    "  <rules>",
    "    <identity>Speak as the roomie in first person. Do not mention your name or role in the content.</identity>",
    "    <voice>Match the tone, cadence, and attitude implied by the agent bio.</voice>",
    "    <language>Use the same language as the latest user message.</language>",
    "    <output>No thought lines, no hidden commentary, no extra JSON shapes.</output>",
    "  </rules>",
    "</system>",
  ].join("\n");

export const buildSummarizerMessages = (params: {
  shared: SharedState;
  userMessage?: string;
  userName: string;
  agentNames: Map<string, string>;
  speakerOutputs: SpeakerOutput[];
  systemPrompt: string;
}): SimplePrompt => {
  const promptBlocks: string[] = [
    `CURRENT_SHARED:\n${renderShared(params.shared)}`,
    `LAST_MESSAGES:\n${renderLastMessages(params.shared, { userName: params.userName, agentNames: params.agentNames })}`,
  ];

  if (params.userMessage) {
    promptBlocks.push(`NEW_USER_MESSAGE:\n${params.userMessage}`);
  }

  if (params.speakerOutputs.length) {
    promptBlocks.push(
      `SPEAKER_OUTPUTS:\n${stringifyCompact(
        params.speakerOutputs.map((output) => ({
          agent_id: output.agent_id,
          intent: output.intent,
          text: output.text,
        }))
      )}`
    );
  }

  return { system: params.systemPrompt, prompt: promptBlocks.filter(Boolean).join("\n\n") };
};

export const buildSpeakerMessages = (params: {
  shared: SharedState;
  agent: { id: string; name: string; bio: string; role?: string | null; outputStyle?: string | null };
  intent: string;
  userMessage?: string;
  roomies: { name: string; bio: string }[];
  turnOutputs?: SpeakerOutput[];
  historyLines: string[];
  systemPrompt: string;
  agentMemory?: string[];
}): SimplePrompt => {
  const systemBlocks: string[] = [
    params.systemPrompt,
    renderSpeakerGuardrailsXml(),
    renderAgentPropsXml(params.agent),
    renderSpeakerRuntimeXml({ intent: params.intent }),
    renderSpeakerContextXml({
      roomies: params.roomies,
      shared: params.shared,
      turnOutputs: params.turnOutputs,
      agentMemory: params.agentMemory,
    }),
  ].filter(Boolean);

  const promptBlocks: string[] = [];
  if (params.historyLines.length) {
    promptBlocks.push(`LAST_MESSAGES:\n${params.historyLines.filter(Boolean).join("\n")}`);
  }
  if (params.userMessage) {
    promptBlocks.push(`USER: ${params.userMessage}`);
  }

  return { system: systemBlocks.join("\n\n"), prompt: promptBlocks.filter(Boolean).join("\n\n") };
};
