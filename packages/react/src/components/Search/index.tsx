/**
 * `@modernrelay/orbit-react/components/Search` — `<GraphSearch>`, the
 * search box.
 *
 * Owns exactly the UI half of the split: the text input, the debounce
 * window, and the result list. Everything correctness-critical lives in the
 * instance (`instance.search` creates the RequestContext, caches by declared
 * revisions, cancels superseded work, and rejects stale results at admission);
 * this component just issues ONE `instance.search` per settled
 * debounce window and renders `store.search`.
 *
 * Behavior:
 * - typing schedules `instance.search(query, {limit})` after `debounceMs`
 * (default 200); a keystroke inside the window replaces the pending call, so
 * there is one service call per settled window, never one per keystroke;
 * - emptying the input cancels the pending call and clears the shared slice
 * (`instance.clearSearch`), so the navigator section disappears too;
 * - the result list reads `store.search`, the single source of truth; bespoke
 * UIs and the navigator observe the same slice. `score` renders
 * when the service supplied one;
 * - Enter / click activates via `instance.activateSearchResult`: 'focused'
 * closes the listbox and clears the active-option highlight; otherwise
 * `onResultUnavailable(result, reason)` fires — falling back to the
 * `<Graph onSearchResultUnavailable>` default when no local prop is given
 * (the HOST reacts; search never mutates
 * scope/filters behind the user's back);
 * - I6 (query coherence): Enter only activates when `store.search.query`
 * matches the current input — after an edit, the previous query's rows may
 * keep showing through the debounce window, but Enter is a no-op until the
 * edited query's publication lands (clicks on visible rows stay live);
 * - Escape clears: input text, pending debounce, active option, and the
 * store slice (`instance.clearSearch`).
 *
 * ARIA: the combobox pattern — `role="combobox"` input with
 * `aria-expanded`/`aria-controls`/`aria-activedescendant` over a
 * `role="listbox"` of `role="option"` rows; ArrowDown/ArrowUp move the active
 * option (no wrap), Home/End jump. Option DOM ids are index-derived (node ids
 * are untrusted text). All result-derived text (label, id, score) renders as
 * TEXT NODES only — `renderResult` is the customization escape hatch.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from 'react';
import type { GraphStoreState, SearchResult, SearchUnavailableReason } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';
import { getSearchResultUnavailableCallback } from '../../hooks';

/** Store slice subscription local to this component (the ambient hooks in
 * ../../hooks require the provider; here the instance may be an explicit
 * prop). `store.search` is a stable reference per publication, so the raw
 * selector needs no memo. */
function useSearchSlice(
  instance: AnyGraphInstance,
): { query: string; results: readonly SearchResult[] } | null {
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback(
    (): GraphStoreState['search'] => instance.store.getState().search,
    [instance],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** defaults (mirror the instance's SEARCH_LIMIT_DEFAULT). */
const DEBOUNCE_MS_DEFAULT = 200;
const LIMIT_DEFAULT = 20;

export interface GraphSearchProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  placeholder?: string;
  /** Debounce window in ms — one `instance.search` per settled window. Default 200. */
  debounceMs?: number;
  /** Result cap forwarded to the service. Default 20. */
  limit?: number;
  /**
   * result contract: fired when an activated result cannot be focused
   * ('not-loaded' | 'out-of-scope' | 'filtered'). Defaults to the
   * `<Graph onSearchResultUnavailable>` prop when omitted.
   */
  onResultUnavailable?: (result: SearchResult, reason: SearchUnavailableReason) => void;
  /** Custom option content (rendered INSIDE the option row). Default: label
   * text node + score (when present). */
  renderResult?: (r: SearchResult) => ReactNode;
  /** Accessible name of the search box. Default 'Search graph'. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

// --- styling defaults (headless-styleable: className/style override) ---
const ROOT_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxWidth: 320,
  font: '13px/1.4 system-ui, sans-serif',
};
const LIST_STYLE: CSSProperties = {
  margin: 0,
  padding: 4,
  listStyle: 'none',
  overflowY: 'auto',
  maxHeight: 240,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
};
const OPTION_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const ACTIVE_OPTION_STYLE: CSSProperties = {
  ...OPTION_STYLE,
  outline: '2px solid currentColor',
  outlineOffset: -2,
};
const SCORE_STYLE: CSSProperties = { opacity: 0.65, fontVariantNumeric: 'tabular-nums' };
const EMPTY_STYLE: CSSProperties = { padding: '4px 8px', fontStyle: 'italic', opacity: 0.8 };

export function GraphSearch(props: GraphSearchProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphSearch>');
  const search = useSearchSlice(instance);

  const debounceMs = props.debounceMs ?? DEBOUNCE_MS_DEFAULT;
  const limit = props.limit ?? LIMIT_DEFAULT;

  const baseId = useId();
  const listboxId = `${baseId}search-listbox`;

  const [query, setQuery] = useState('');
  /** Listbox visibility — closed by 'focused' activation / Escape until the
   * next keystroke reopens it. */
  const [open, setOpen] = useState(false);
  /** Active option index; -1 = no active option (highlight cleared). */
  const [activeIndex, setActiveIndex] = useState(-1);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Unmount/instance-swap hygiene: never fire a search for a dead widget.
  useEffect(() => cancelPending, [instance]);

  const results: readonly SearchResult[] = search === null ? [] : search.results;
  /** I6 query coherence: the published slice answers the CURRENT input only
   * when its query matches what this box sent to `instance.search` (the raw
   * input value — neither side normalizes). Stale results may keep showing
   * through the debounce window (combobox convention: don't blank the
   * listbox), but implicit activation is gated on this. */
  const current = search !== null && search.query === query;
  const expanded = open && search !== null;
  const activeOptionId =
    expanded && activeIndex >= 0 && activeIndex < results.length
      ? `${baseId}search-opt-${activeIndex}`
      : undefined;

  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value;
    setQuery(value);
    setActiveIndex(-1);
    cancelPending();
    if (value === '') {
      // Input emptied: clear the shared slice immediately — no
      // trailing search may resurrect stale results.
      setOpen(false);
      instance.clearSearch();
      return;
    }
    setOpen(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Supersede/staleness rejections are by-design outcomes — the
      // diagnostics channel carries the why; the box just shows the latest
      // completed publication via store.search.
      void instance.search(value, { limit }).catch(() => {});
    }, debounceMs);
  };

  const clearAll = (): void => {
    cancelPending();
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    instance.clearSearch();
  };

  const activate = (result: SearchResult): void => {
    const activation = instance.activateSearchResult(result);
    if (activation.status === 'focused') {
      // Focused: close the listbox and clear the highlight.
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    const cb = props.onResultUnavailable ?? getSearchResultUnavailableCallback(instance);
    cb?.(result, activation.reason);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        if (results.length === 0) return;
        setOpen(true);
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
        break;
      case 'ArrowUp':
        if (results.length === 0) return;
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        if (!expanded || results.length === 0) return;
        setActiveIndex(0);
        break;
      case 'End':
        if (!expanded || results.length === 0) return;
        setActiveIndex(results.length - 1);
        break;
      case 'Enter': {
        // I6: Enter (and its first-result fallback) activates only against a
        // publication answering the CURRENT input — while the edited query is
        // still in its debounce window, Enter is a no-op (input and listbox
        // untouched). Pointer clicks on visible rows stay unguarded: the user
        // activates exactly what they saw.
        if (!current) return;
        const target = results[activeIndex] ?? results[0];
        if (target === undefined) return;
        activate(target);
        break;
      }
      case 'Escape':
        clearAll();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const boxLabel = props.label ?? 'Search graph';

  return (
    <div
      data-orbit-search=""
      className={props.className}
      style={{ ...ROOT_STYLE, ...props.style }}
    >
      <input
        data-orbit-search-input=""
        type="text"
        role="combobox"
        aria-label={boxLabel}
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {expanded ? (
        <ul id={listboxId} role="listbox" aria-label={`${boxLabel} results`} style={LIST_STYLE}>
          {results.length === 0 ? (
            <li data-orbit-search-empty="" role="presentation" style={EMPTY_STYLE}>
              No results
            </li>
          ) : (
            results.map((r, index) => (
              <li
                key={`${index}:${r.id}`}
                id={`${baseId}search-opt-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-orbit-search-result={r.id}
                style={index === activeIndex ? ACTIVE_OPTION_STYLE : OPTION_STYLE}
                onPointerEnter={() => {
                  setActiveIndex(index);
                }}
                onClick={() => {
                  activate(r);
                }}
              >
                {props.renderResult !== undefined ? (
                  props.renderResult(r)
                ) : (
                  <>
                    {/* Result text is untrusted — TEXT NODES only. */}
                    <span data-orbit-search-result-label="">{r.label ?? r.id}</span>
                    {r.score !== undefined ? (
                      <span data-orbit-search-result-score="" style={SCORE_STYLE}>
                        {String(r.score)}
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
