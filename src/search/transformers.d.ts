/**
 * Minimal shim for the optional dependency. The real package may be absent at
 * build time (installed with --omit=optional), so we never import its types.
 */
declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>
  ): Promise<
    (text: string, options?: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>
  >;
}
