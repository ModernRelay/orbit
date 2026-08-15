/**
 * Rows adapter: `readonly unknown[]` or `AsyncIterable` of row objects
 * → RowTable. Columns are sampled from the FIRST row; every row must be a
 * plain object.
 */

import { EMPTY_ROW_TABLE, isPlainRowObject, type RowTable } from './rowTable';
import { peekAsyncIterable, rowStream } from './sources';

export async function rowsTable(
  source: readonly unknown[] | AsyncIterable<unknown>,
  signal: AbortSignal | undefined,
  /** Lane label for error messages ('node' | 'edge'). */
  role: string,
): Promise<RowTable> {
  const stream = rowStream(source, signal);
  const { first, done, rest, close } = await peekAsyncIterable(stream);
  if (done) return EMPTY_ROW_TABLE;
  if (!isPlainRowObject(first)) {
    // Close the underlying source before reporting: the replay
    // generator was never started, so ITS return would skip the finally
    // close reaches the source iterator directly.
    await close();
    throw new TypeError(
      `prepareGraphData: ${role} row sources must yield plain row objects ` +
        `(got ${first === null ? 'null' : typeof first})`,
    );
  }
  const columns = Object.keys(first);
  return {
    columns,
    rows: (async function* () {
      let index = 0;
      for await (const row of rest) {
        if (!isPlainRowObject(row)) {
          throw new TypeError(
            `prepareGraphData: ${role} row ${index} is not a plain row object`,
          );
        }
        yield row;
        index++;
      }
    })(),
  };
}
