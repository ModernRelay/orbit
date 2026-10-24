/**
 * Source-kind detection and byte/row stream normalization.
 *
 * The package accepts exactly these source shapes:
 * GraphRowSource = readonly unknown[] | AsyncIterable<unknown>
 * GraphByteSource = Blob | ArrayBuffer | AsyncIterable<Uint8Array>
 *
 * An `AsyncIterable` is ambiguous between the two — when the caller supplies
 * no explicit `format`, the first element is peeked: `Uint8Array` chunks mean
 * bytes (CSV lane), anything else means row objects. The peeked element is
 * pushed back, so adapters observe the full stream.
 */

import type { PreparationControl } from './control';

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === 'AbortError') throw signal.reason;
    throw new DOMException('prepareGraphData: aborted', 'AbortError');
  }
}

/** Stop waiting on caller I/O when cancelled; late settlement is still observed. */
export async function abortable<T>(pending: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => {
      signal.removeEventListener('abort', cancel);
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(pending).then(
      (value) => { signal.removeEventListener('abort', cancel); resolve(value); },
      (error) => { signal.removeEventListener('abort', cancel); reject(error); },
    );
    if (signal.aborted) cancel();
  });
}

async function closeAfterFailure(close: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    // An async generator can queue return() behind an uncooperative next().
    // Request teardown but do not make cancellation wait for that foreign I/O.
    void close().catch(() => {});
  } else await close();
}

export function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Iterator teardown is caller-owned protocol, not necessarily an idempotent
 * async-generator method. Memoize the first close so nested replay/adapter
 * wrappers can all settle without invoking an arbitrary `return()` twice.
 */
function iteratorCloseOnce<T>(iterator: AsyncIterator<T>): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= (async () => {
      await iterator.return?.();
    })();
    return closePromise;
  };
}

/**
 * Drive an arbitrary async iterator behind an async-generator boundary that
 * guarantees `return()` on early exit *and* when `next()` rejects. Native
 * `for await` does not close an iterator whose own `next()` rejects.
 */
async function* closingIterable<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const close = iteratorCloseOnce(iterator);
  let exhausted = false;
  let failed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await abortable(iterator.next(), signal);
      if (next.done) {
        exhausted = true;
        return;
      }
      yield next.value;
    }
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    if (!exhausted) {
      try {
        await closeAfterFailure(close, signal);
      } catch (closeCause) {
        // A failed read/consumer operation is the useful outcome. Teardown
        // failure is surfaced only when there is no earlier failure to mask.
        if (!failed) throw closeCause;
      }
    }
  }
}

/** An async iterable with its first element already consumed and re-yielded.
 * `done` distinguishes a completed source from one whose first yield was
 * `undefined`; conflating them silently discarded the whole source instead
 * of reporting malformed row zero. */
export async function peekAsyncIterable(
  source: AsyncIterable<unknown>,
  signal?: AbortSignal,
): Promise<{
  first: unknown | undefined;
  done: boolean;
  rest: AsyncIterable<unknown>;
  /** Close the underlying iterator directly: calling return
   * on the un-started replay generator completes without entering its body,
   * so its finally cannot forward — validation-failure paths close here. */
  close: () => Promise<void>;
}> {
  const iterator = source[Symbol.asyncIterator]();
  const close = iteratorCloseOnce(iterator);
  let head: IteratorResult<unknown>;
  try {
    throwIfAborted(signal);
    head = await abortable(iterator.next(), signal);
  } catch (cause) {
    try {
      await closeAfterFailure(close, signal);
    } catch {
      // Preserve the iterator's read failure; teardown is best-effort here.
    }
    throw cause;
  }
  const first = head.done ? undefined : head.value;
  async function* replay(): AsyncGenerator<unknown> {
    let exhausted = head.done === true;
    let failed = false;
    try {
      if (!head.done) yield head.value;
      // Delegate to the original iterator (not the iterable) so nothing is lost.
      while (true) {
        throwIfAborted(signal);
        const next = await abortable(iterator.next(), signal);
        if (next.done) {
          exhausted = true;
          return;
        }
        yield next.value;
      }
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      // Early exit or a downstream throw must close the source;
      // file handles, network bodies, and generator finally-blocks hang off
      // return. A rejected next() also needs explicit teardown.
      if (!exhausted) {
        try {
          await closeAfterFailure(close, signal);
        } catch (closeCause) {
          if (!failed) throw closeCause;
        }
      }
    }
  }
  return {
    first,
    done: head.done === true,
    rest: replay(),
    close,
  };
}

/** Normalize any GraphByteSource to an async chunk stream. */
export function byteChunks(
  source: Blob | ArrayBuffer | AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  control?: PreparationControl,
): AsyncIterable<Uint8Array> {
  async function* rawChunks(): AsyncGenerator<Uint8Array> {
    throwIfAborted(signal);
    if (source instanceof ArrayBuffer) { yield new Uint8Array(source); return; }
    const stream = isBlob(source)
      ? source.stream() as unknown as AsyncIterable<Uint8Array>
      : source;
    yield* closingIterable(stream, signal);
  }
  return (async function* () {
    for await (const chunk of rawChunks()) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new TypeError('prepareGraphData: byte sources must yield Uint8Array chunks');
      // Cap parser work per chunk even for an already-resident ArrayBuffer.
      for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
        throwIfAborted(signal);
        const slice = chunk.subarray(offset, Math.min(chunk.byteLength, offset + 64 * 1024));
        control?.read(slice.byteLength);
        yield slice;
        await control?.checkpoint();
      }
    }
    throwIfAborted(signal);
  })();
}

/** Collect a full byte source into one Uint8Array (JSON/Arrow/Parquet lanes). */
export async function collectBytes(
  source: Blob | ArrayBuffer | AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  control?: PreparationControl,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of byteChunks(source, signal, control)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  throwIfAborted(signal);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Normalize a row source (array or async iterable of rows) to a stream. */
export function rowStream(
  source: readonly unknown[] | AsyncIterable<unknown>,
  signal: AbortSignal | undefined,
): AsyncIterable<unknown> {
  if (Array.isArray(source)) {
    const rows = source as readonly unknown[];
    return (async function* () {
      for (let i = 0; i < rows.length; i++) {
        if ((i & 255) === 0) throwIfAborted(signal);
        yield rows[i];
      }
    })();
  }
  if (isAsyncIterable(source)) {
    return (async function* () {
      for await (const row of closingIterable(source, signal)) {
        throwIfAborted(signal);
        yield row;
      }
    })();
  }
  throw new TypeError(
    'prepareGraphData: row sources must be an array or an AsyncIterable of row objects',
  );
}
