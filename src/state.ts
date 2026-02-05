import type { RoomState } from "./types";

export const createInitialRoomState = (): RoomState => ({
  shared: {
    goal: "",
    summary_window: "",
    last_messages: [],
    agent_memory: {},
    turn_index: 0,
  },
  runtime: {
    turn_index: 0,
    speaker_plan: [],
    speaker_outputs: [],
    turn_trace: [],
  },
});
