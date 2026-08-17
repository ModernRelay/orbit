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

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    throw new Error('prepareGraphData: aborted');
  }
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
async function* closingIterable<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const close = iteratorCloseOnce(iterator);
  let exhausted = false;
  let failed = false;
  try {
    while (true) {
      const next = await iterator.next();
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
        await close();
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
    head = await iterator.next();
  } catch (cause) {
    try {
      await close();
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
        const next = await iterator.next();
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
          await close();
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
): AsyncIterable<Uint8Array> {
  if (source instanceof ArrayBuffer) {
    const chunk = new Uint8Array(source);
    return (async function* () {
      throwIfAborted(signal);
      yield chunk;
    })();
  }
  if (isBlob(source)) {
    return (async function* () {
      // Blob.stream is a web ReadableStream; async-iterable in Node ≥18.
      const stream = source.stream() as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of closingIterable(stream)) {
        throwIfAborted(signal);
        yield chunk;
      }
    })();
  }
  return (async function* () {
    for await (const chunk of closingIterable(source)) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError(
          'prepareGraphData: byte sources must yield Uint8Array chunks',
        );
      }
      yield chunk;
    }
  })();
}

/** Collect a full byte source into one Uint8Array (JSON/Arrow/Parquet lanes). */
export async function collectBytes(
  source: Blob | ArrayBuffer | AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of byteChunks(source, signal)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
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
      for await (const row of closingIterable(source)) {
        throwIfAborted(signal);
        yield row;
      }
    })();
  }
  throw new TypeError(
    'prepareGraphData: row sources must be an array or an AsyncIterable of row objects',
  );
}
