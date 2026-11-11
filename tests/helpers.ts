import type { Agent, Chunk, HostContext, RequestOptions, StepPayload } from '../src/types.js';
import type { StabilizerAPI } from '../src/index.js';
export class FakeHost implements HostContext {
  hooks = new Map<string, ((...args: any[]) => any)[]>();
  values = new Map<string, unknown>();
  disposers: (() => void | Promise<void>)[] = [];
  warnings: unknown[][] = [];
  logger = { info: (..._args: unknown[]) => {}, warn: (...args: unknown[]) => { this.warnings.push(args); } };
  on(name: string, listener: (...args: any[]) => any) {
    const list = this.hooks.get(name) ?? []; list.push(listener); this.hooks.set(name, list);
    const dispose = () => { const at = list.indexOf(listener); if (at >= 0) list.splice(at, 1); };
    this.disposers.push(dispose); return dispose;
  }
  get(name: string) { return this.values.get(name); }
  provide(name: string, value: unknown) { this.values.set(name, value); this.disposers.push(() => { this.values.delete(name); }); }
  effect(effect: () => (() => void | Promise<void>)) { this.disposers.push(effect()); }
  emit(name: string, ...args: any[]) { for (const listener of this.hooks.get(name) ?? []) listener(...args); }
  waterfall(name: string, args: unknown[], fallback: () => any): any {
    const listeners = [...this.hooks.get(name) ?? []];
    const next = (): any => { const listener = listeners.shift(); return listener ? listener(...args, next) : fallback(); };
    return next();
  }
  async close() { for (const dispose of this.disposers.reverse()) await dispose(); }
  status() { return (this.values.get('flashStabilizer') as StabilizerAPI).status(); }
}
export function makeAgent(id = 'test'): Agent {
  return { id, options: { provider: 'mock', model: 'deepseek-flash' }, status: 'running', inbox: { nextStep: [], nextTurn: [] } };
}
export const repeated = '需要继续检查问题的来源并确认下一步可以执行的必要操作。'.repeat(200);
export function chunks(text: string, size = 73, type = 'reasoning'): Chunk[] {
  const result: Chunk[] = [{ type: 'block-start', index: 0, blockType: type }];
  for (let i = 0; i < text.length; i += size) result.push({ type: `${type === 'reasoning' ? 'reasoning' : 'text'}-delta`, index: 0, text: text.slice(i, i + size) });
  return [...result, { type: 'block-end', index: 0, block: { type, text } }, { type: 'finish', reason: { kind: 'stop' } }];
}
export async function stream(host: FakeHost, agent: Agent, input: Chunk[], modern: boolean, override: Partial<RequestOptions> = {}, source = 'user') {
  const controller = new AbortController();
  const step: StepPayload = { agent, turn: 1, step: 1, signal: controller.signal, messages: [{ source: { kind: source } }] };
  const decision = Object.freeze({ kind: 'enter', messages: step.messages, startsRequestSeries: true });
  const entered = await host.waterfall('agent/pre-step', [step], () => Promise.resolve(decision));
  if (entered !== decision) throw new Error('downstream decision was modified');
  const options = Object.freeze({ sessionId: agent.id, provider: 'mock', model: 'deepseek-flash', signal: controller.signal, ...override });
  if (modern) host.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'attempt-1' } });
  const output: Chunk[] = [];
  async function* upstream() { for (const chunk of input) yield chunk; }
  const wrapped = host.waterfall('llm/stream', [options], () => upstream());
  for await (const chunk of wrapped) {
    if (modern) host.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'attempt-1', chunk } });
    output.push(chunk);
  }
  return output;
}
