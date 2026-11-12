/** Structural boundary: no runtime imports of version-specific DSH packages. */
export type Chunk = { type: string; index?: number; text?: string; blockType?: string; block?: { type: string; text?: string }; [key: string]: unknown };
export interface UserMessage {
  id: string; role: 'user'; source: { kind: 'flash-stabilizer'; form: 'notice'; summary: string };
  content: { type: 'text'; text: string }[];
}
export interface Agent {
  id: string;
  options?: { model?: string; provider?: string };
  model?: { current(): { model: string; provider: string } | undefined };
  status?: string;
  inbox?: { nextTurn: readonly unknown[]; nextStep: readonly unknown[] };
  cancel?(cause: { kind: 'hook'; reason: string }, options: { keepInbox: true }): void;
  followup?(message: UserMessage): void;
  inject?(message: UserMessage): void;
  session?: { snapshotEvents?(): readonly SessionEvent[] };
}
export interface SessionEvent { type: string; data: Record<string, unknown> }
export interface RequestOptions {
  sessionId?: string; model?: string; provider?: string; purpose?: string; signal?: AbortSignal;
  [key: string]: unknown;
}
export interface StepPayload {
  agent: Agent; turn: number; step: number; signal: AbortSignal;
  messages: readonly { source?: { kind?: string } }[];
  modelSelection?: { model: string; provider: string };
}
export interface ToolExecution { name: string; arguments: unknown; agent?: Agent; signal?: AbortSignal }
export interface ToolResult { isError: boolean; content?: unknown; value?: unknown; error?: unknown; meta?: unknown }
export interface HostContext {
  on(name: string, listener: (...args: any[]) => any): () => void;
  effect(effect: () => (() => void | Promise<void>), label?: string): unknown;
  get?(name: string, strict?: boolean): unknown;
  inject?(names: string[], callback: (ctx: HostContext & { connection?: ConnectionService }) => void): unknown;
  provide?(name: string, value: unknown): unknown;
  logger?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  agents?: { get(id: string): Agent | undefined; list?(): Agent[] };
}
export interface ConnectionService {
  rpc: { handle(channel: string, handler: RpcHandler): unknown };
  register?(owner: HostContext, channel: string, handler: RpcHandler): unknown;
}
export type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: { principal?: { kind?: string } }) => unknown;
export interface Notice {
  kind: 'stream-repeat' | 'tool-repeat' | 'test-repeat' | 'recovery' | 'compatibility' | 'internal-error';
  session: string; score: number; confirmed: boolean; chars: number;
  period?: number; repeats?: number; action?: string;
  contentType?: 'reasoning' | 'text'; turn?: number; step?: number;
  coverage?: number; novelty?: number;
  method?: 'periodic' | 'phrase';
  uncertainty?: 'changing-numbered-units';
}
