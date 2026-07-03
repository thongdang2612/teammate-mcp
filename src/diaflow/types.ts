export interface StarterPrompt {
  title: string;
  prompt: string;
}

export interface Agent {
  id: number;
  uniqueId: string;
  name?: string;
  title?: string;
  modelProvider?: string;
  modelName?: string;
  icon?: string;
  description?: string;
  intelligence?: string;
  tags?: string[];
  status?: string;
}

export interface AgentSkillBrief {
  id: number;
  uniqueId: string;
  name: string;
}

export interface AgentDetail extends Agent {
  instruction?: string;
  welcomeMessage?: string;
  starterPrompts?: StarterPrompt[];
  skills?: AgentSkillBrief[];
  skillsCount?: number;
  subAgentsCount?: number;
}

export interface TeammatePage {
  total: number;
  results: Agent[];
}

export interface UpdateTeammateFields {
  name?: string;
  title?: string;
  modelProvider?: string;
  modelName?: string;
  modelConfig?: Record<string, unknown>;
  outputFormat?: string;
  icon?: string;
  description?: string;
  instruction?: string;
  welcomeMessage?: string;
  intelligence?: string;
  starterPrompts?: StarterPrompt[];
  tags?: string[];
}

export interface CreateTeammateFields extends UpdateTeammateFields {
  modelProvider: string;
  modelName: string;
}

export interface PresignResponse {
  uploadUrl: string;
  key: string;
  url: string;
}

export interface PresetAvatar {
  url: string;
  category?: string;
}

export interface AgentSkillLink {
  id: number;
  uniqueId?: string;
  name: string;
  source?: string;
}

export interface AvailableSkill {
  id: number;
  uniqueId?: string;
  name: string;
  source?: string;
  isAttached?: boolean;
}

export interface SkillRef {
  skillWorkspaceId?: number;
  skillSystemId?: number;
  skillUserId?: number;
}

export interface FileRef {
  filename: string;
  path: string;
  size?: number;
  artifact_url?: string;
}

export type RunStatus = "completed" | "working" | "unknown";

export interface CompletionResult {
  status: RunStatus;
  threadId: string;
  reply?: string;
  usage?: { totalTokens?: number };
}

export interface RunResult {
  status: RunStatus;
  threadId: string;
  reply?: string;
}
