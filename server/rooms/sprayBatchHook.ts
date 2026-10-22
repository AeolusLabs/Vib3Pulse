// Leaf module (imports nothing at run time): the one place the team-spray batch finalizer is stored. spray.ts reads it and
// teamSpray.ts registers into it, so neither needs the other at module-init time (they sit in an import cycle through
// roomSocket / clawbacks, and a top-level call into a const of a half-loaded module throws a ReferenceError).
import type { PoolClient } from "pg";
import type { FinalizeOpts, FinalizeOutcome } from "./spray";

export type BatchFinalizer = (c: PoolClient, reference: string, opts: FinalizeOpts) => Promise<FinalizeOutcome | null>;
let current: BatchFinalizer | null = null;
export function registerBatchFinalizer(fn: BatchFinalizer | null): void { current = fn; }
export function batchFinalizer(): BatchFinalizer | null { return current; }
