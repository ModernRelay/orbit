/**
 * history command-stack kernel.
 *
 * v0.7 implements the KERNEL only: value-diff commands, transactions,
 * coalescing, and a bounded stack. The kernel never touches stores — it is a
 * pure application seam: `undo`/`redo` return the command list to apply
 * (already inverted, in application order) and move the cursor; the instance
 * applies commands to its slices and publishes.
 * Ownership-mode acknowledgement walks and view-state integration remain
 * instance-level concerns.
 *
 * Commands are `{ slice, before, after }` value diffs — never closures — so
 * they are serializable and invert by swapping. The kernel freezes and stores
 * exactly what it is given (no structuredClone): callers pass plain values /
 * arrays and must not mutate them afterward. A DEV-only serializability walk
 * (no functions, no Map/Set — callers convert) runs behind the `debug` flag.
 */

/** One history-worthy mutation: a serializable value diff over a named slice. */
export interface HistoryCommand {
  readonly slice: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Depth snapshot published to subscribers (mirrors GraphStoreState.history). */
export interface HistoryDepths {
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export interface HistoryKernelOptions {
  /** Stack bound; oldest entry evicted past it. */
  limit?: number;
  /** `false` = the `history: false` prop: everything is a no-op, depths stay 0. */
  enabled?: boolean;
  /** DEV-only: walk recorded payloads and throw on non-serializable values. */
  debug?: boolean;
}

export const HISTORY_LIMIT_DEFAULT = 50;

/** One undoable step: 1..n commands applied/inverted atomically in order. */
interface HistoryEntry {
  label: string | undefined;
  commands: HistoryCommand[];
}

interface CoalesceTag {
  key: string;
  windowMs: number;
  time: number;
}

/**
 * DEV serializability walk: rejects functions, Map/Set (callers convert),
 * symbols, bigints, and cycles. Plain objects/arrays and JSON scalars pass.
 */
function assertSerializable(value: unknown, slice: string): void {
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    switch (typeof v) {
      case 'function':
        throw new TypeError(
          `history command for slice "${slice}" carries a function at ${path} — commands are value diffs, not closures`,
        );
      case 'symbol':
      case 'bigint':
        throw new TypeError(
          `history command for slice "${slice}" carries a ${typeof v} at ${path} — not serializable`,
        );
      case 'object':
        break;
      default:
        return; // string | number | boolean | undefined
    }
    if (v === null) return;
    if (v instanceof Map || v instanceof Set) {
      throw new TypeError(
        `history command for slice "${slice}" carries a ${v instanceof Map ? 'Map' : 'Set'} at ${path} — convert to arrays/objects before recording`,
      );
    }
    if (seen.has(v)) {
      throw new TypeError(`history command for slice "${slice}" carries a cycle at ${path} — not serializable`);
    }
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
    } else {
      for (const [k, child] of Object.entries(v)) walk(child, `${path}.${k}`);
    }
    seen.delete(v);
  };
  walk(value, '$');
}

/**
 * Bounded undo/redo command stack. Store-agnostic: see module doc for the
 * application seam. All methods are synchronous; there is no async state.
 */
export class HistoryKernel {
  private readonly limit: number;
  private readonly enabled: boolean;
  private readonly debug: boolean;

  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  /** Nested begin joins the outer transaction (depth-counted). */
  private txDepth = 0;
  private txCommands: HistoryCommand[] = [];
  private txLabel: string | undefined;
  private txCoalesce: CoalesceTag | null = null;

  /**
   * Coalescing chain anchor: the tag of the most recently PUSHED entry, valid
   * only while that entry is still the top of the undo stack with nothing in
   * between — any undo/redo/clear or non-coalesced push breaks the chain.
   */
  private lastCoalesce: CoalesceTag | null = null;

  private readonly listeners = new Set<(depths: HistoryDepths) => void>();
  private lastDepths: HistoryDepths = Object.freeze({ undoDepth: 0, redoDepth: 0 });

  constructor(options: HistoryKernelOptions = {}) {
    const { limit = HISTORY_LIMIT_DEFAULT, enabled = true, debug = false } = options;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`history limit must be a positive integer (got ${String(limit)})`);
    }
    this.limit = limit;
    this.enabled = enabled;
    this.debug = debug;
  }

  /** Open a transaction; nested calls join the outer one (depth-counted). */
  begin(label?: string): void {
    if (!this.enabled) return;
    if (this.txDepth === 0) {
      this.txCommands = [];
      this.txLabel = label;
      this.txCoalesce = null;
    }
    this.txDepth++;
  }

  /**
   * Open a coalescing transaction: consecutive transactions with the same
   * `key` within `windowMs` MERGE into the prior stack entry (original before
   * kept, after replaced per slice) — camera drags, timeline play sessions.
   * Nested inside an open transaction it joins the outer one unchanged.
   * `now` is injectable for tests; each merge refreshes the window anchor.
   */
  beginCoalesced(key: string, windowMs: number, now: () => number = Date.now): void {
    if (!this.enabled) return;
    if (this.txDepth === 0) {
      this.txCommands = [];
      this.txLabel = undefined;
      this.txCoalesce = { key, windowMs, time: now() };
    }
    this.txDepth++;
  }

  /**
   * Record one value-diff command. Inside a transaction it appends to the
   * pending entry; outside it wraps itself in an implicit single-command
   * transaction. The kernel freezes and stores what it is given.
   */
  record(slice: string, before: unknown, after: unknown): void {
    if (!this.enabled) return;
    if (this.debug) {
      assertSerializable(before, slice);
      assertSerializable(after, slice);
    }
    const command: HistoryCommand = Object.freeze({ slice, before, after });
    if (this.txDepth > 0) {
      this.txCommands.push(command);
      return;
    }
    this.pushEntry({ label: undefined, commands: [command] }, null);
  }

  /** Close a transaction; the outermost end pushes one stack entry. */
  end(): void {
    if (!this.enabled) return;
    if (this.txDepth === 0) throw new Error('HistoryKernel.end() without a matching begin()');
    this.txDepth--;
    if (this.txDepth > 0) return;
    const commands = this.txCommands;
    const label = this.txLabel;
    const coalesce = this.txCoalesce;
    this.txCommands = [];
    this.txLabel = undefined;
    this.txCoalesce = null;
    if (commands.length === 0) return; // empty transaction: no entry
    this.pushEntry({ label, commands }, coalesce);
  }

  /**
   * Move the cursor back one entry and return its commands, already inverted
   * (before/after swapped) and in application order (reverse of recorded).
   * Returns null at the bottom of the stack. Does not touch any store.
   */
  undo(): readonly HistoryCommand[] | null {
    if (!this.enabled) return null;
    if (this.txDepth > 0) throw new Error('HistoryKernel.undo() during an open transaction');
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    this.lastCoalesce = null; // chain broken; a redone entry never re-coalesces
    const inverted: HistoryCommand[] = [];
    for (let i = entry.commands.length - 1; i >= 0; i--) {
      const c = entry.commands[i]!;
      inverted.push(Object.freeze({ slice: c.slice, before: c.after, after: c.before }));
    }
    this.notify();
    return Object.freeze(inverted);
  }

  /**
   * Move the cursor forward one entry and return its commands in original
   * application order. Returns null when there is nothing to redo.
   */
  redo(): readonly HistoryCommand[] | null {
    if (!this.enabled) return null;
    if (this.txDepth > 0) throw new Error('HistoryKernel.redo() during an open transaction');
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    this.lastCoalesce = null;
    this.notify();
    return Object.freeze([...entry.commands]);
  }

  peekUndoDepth(): number {
    return this.undoStack.length;
  }

  peekRedoDepth(): number {
    return this.redoStack.length;
  }

  /** Empty both stacks and any pending transaction (datasetKey swaps). */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.txDepth = 0;
    this.txCommands = [];
    this.txLabel = undefined;
    this.txCoalesce = null;
    this.lastCoalesce = null;
    this.notify();
  }

  /** Subscribe to depth CHANGES (not every call). Returns an unsubscriber. */
  subscribe(cb: (depths: HistoryDepths) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Push one entry: any new entry clears the redo branch; a coalesce-tagged
   * entry within the window of a still-anchored same-key predecessor merges
   * into it instead (original before kept, after replaced per slice); pushing
   * past the limit evicts the oldest entry.
   */
  private pushEntry(entry: HistoryEntry, tag: CoalesceTag | null): void {
    this.redoStack.length = 0;
    const anchor = this.lastCoalesce;
    if (tag && anchor && anchor.key === tag.key && tag.time - anchor.time <= tag.windowMs) {
      // lastCoalesce is non-null only when the entry that set it is still the
      // top of the undo stack (undo/redo/clear/non-coalesced push all null it).
      const top = this.undoStack[this.undoStack.length - 1]!;
      for (const cmd of entry.commands) {
        // Replace the LAST command for the slice: its `after` is the entry's
        // net result on replay, while the FIRST command's `before` remains
        // the entry's original before — the merge contract.
        let i = -1;
        for (let j = top.commands.length - 1; j >= 0; j--) {
          if (top.commands[j]!.slice === cmd.slice) {
            i = j;
            break;
          }
        }
        if (i === -1) {
          top.commands.push(cmd);
        } else {
          const prior = top.commands[i]!;
          top.commands[i] = Object.freeze({ slice: prior.slice, before: prior.before, after: cmd.after });
        }
      }
      this.lastCoalesce = tag; // refresh the window anchor for the next merge
      this.notify();
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.lastCoalesce = tag;
    this.notify();
  }

  private notify(): void {
    const undoDepth = this.undoStack.length;
    const redoDepth = this.redoStack.length;
    if (undoDepth === this.lastDepths.undoDepth && redoDepth === this.lastDepths.redoDepth) return;
    this.lastDepths = Object.freeze({ undoDepth, redoDepth });
    for (const cb of this.listeners) cb(this.lastDepths);
  }
}
