/**
 * The Workers AI binding (`env.AI`), shared by the chat's model and its pre-filter. The Worker
 * sets it on its first request; without one (locally, in tests) the chat answers `503` and the
 * filter lets everything through.
 */

/** The part of the Workers AI binding this app uses. */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

let current: AiBinding | undefined;

/** Sets the binding — `env.AI`, from the Worker's first request. */
export function useAi(binding: AiBinding | undefined): void {
  current = binding;
}

/** The binding, or `undefined` when there is none. */
export function getAi(): AiBinding | undefined {
  return current;
}
