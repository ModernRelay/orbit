/** Shared inline styles + palette for the demo overlay UI.
 *
 * Since v0.8, the overlay chrome reads CSS custom properties so the Style
 * panel's theme toggle can swap dark/light without touching every style
 * object — `themeVars(base)` is merged onto the app root and everything
 * below inherits. Dark values match the earlier hardcoded palette exactly.
 */

import type { CSSProperties } from 'react';

export const BACKGROUND = '#0b0e14';

/** Light-base canvas/app background. */
export const LIGHT_BACKGROUND = '#f6f8fa';

/** 6-cluster palette tuned to stay distinguishable on the dark background. */
export const CLUSTER_PALETTE = [
  '#58a6ff', // blue
  '#f77f5f', // coral
  '#3fb950', // green
  '#d2a8ff', // lavender
  '#f2cc60', // gold
  '#39c5cf', // teal
] as const;

export function clusterColor(cluster: number): string {
  return CLUSTER_PALETTE[((cluster % CLUSTER_PALETTE.length) + CLUSTER_PALETTE.length) % CLUSTER_PALETTE.length]!;
}

/** Fixed per-type colors for the Omnigraph fixture graph's closed node-type
 * set; type names are known from the schema before data arrives. */
export const TYPE_PALETTE: Record<string, string> = {
  Actor: '#58a6ff', // blue
  Decision: '#f2cc60', // gold
  Trace: '#d2a8ff', // lavender
  Signal: '#f77f5f', // coral
  Artifact: '#3fb950', // green
};

/** Categorical color for an omnigraph node type: the fixed map when the type
 * is known, otherwise a stable FNV-1a hash into the cluster palette. */
export function typeColor(type: string): string {
  const fixed = TYPE_PALETTE[type];
  if (fixed !== undefined) return fixed;
  let h = 0x811c9dc5;
  for (let i = 0; i < type.length; i++) {
    h ^= type.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return CLUSTER_PALETTE[(h >>> 0) % CLUSTER_PALETTE.length]!;
}

// --- theme variables ----------------------------------------------------------

const DARK_VARS: Record<string, string> = {
  '--app-bg': BACKGROUND,
  '--panel-bg': 'rgba(15, 19, 28, 0.84)',
  '--panel-border': 'rgba(255, 255, 255, 0.08)',
  '--fg': '#e6e9f0',
  '--fg-muted': 'rgba(230, 233, 240, 0.55)',
  '--fg-soft': 'rgba(230, 233, 240, 0.75)',
  '--btn-bg': 'rgba(255, 255, 255, 0.06)',
  '--btn-bg-hover': 'rgba(255, 255, 255, 0.12)',
  '--btn-bg-active': 'rgba(255, 255, 255, 0.18)',
};

const LIGHT_VARS: Record<string, string> = {
  '--app-bg': LIGHT_BACKGROUND,
  '--panel-bg': 'rgba(255, 255, 255, 0.9)',
  '--panel-border': 'rgba(27, 31, 36, 0.14)',
  '--fg': '#1f2328',
  '--fg-muted': 'rgba(31, 35, 40, 0.6)',
  '--fg-soft': 'rgba(31, 35, 40, 0.78)',
  '--btn-bg': 'rgba(27, 31, 36, 0.05)',
  '--btn-bg-hover': 'rgba(27, 31, 36, 0.1)',
  '--btn-bg-active': 'rgba(27, 31, 36, 0.16)',
};

/** Custom-property block merged onto the app root; every panel below reads
 * the variables, so a base flip re-skins the whole overlay in one style. */
export function themeVars(base: 'dark' | 'light'): CSSProperties {
  return (base === 'dark' ? DARK_VARS : LIGHT_VARS) as CSSProperties;
}

const panelBase: CSSProperties = {
  pointerEvents: 'auto',
  background: 'var(--panel-bg)',
  border: '1px solid var(--panel-border)',
  borderRadius: 10,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  color: 'var(--fg)',
  boxShadow: '0 2px 12px rgba(0, 0, 0, 0.35)',
};

export const appRoot: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  background: 'var(--app-bg, #0b0e14)',
};

export const graphStyle: CSSProperties = {
  width: '100%',
  height: '100%',
};

export const overlayRoot: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  padding: 14,
  fontSize: 13,
  zIndex: 10,
};

export const topRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  flexWrap: 'wrap',
};

export const headerPanel: CSSProperties = {
  ...panelBase,
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  padding: '10px 14px',
};

/** Left column of the top row: the header with the Data panel under it. */
export const headerColumn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 8,
  // The stacked panels (Data/Omnigraph/Filters/Style) must never grow past
  // the viewport and push the bottom chart strip off-screen (regression
  // at 800px-tall viewports): cap and scroll instead. The column itself is
  // pointer-inert; the panels inside opt in, and wheel events over them
  // scroll this container.
  maxHeight: 'calc(100vh - 190px)',
  overflowY: 'auto',
  overflowX: 'hidden',
  paddingRight: 4,
};

// --- Data panel (streaming ingestion + scope controls) -----------------------

export const dataPanel: CSSProperties = {
  ...panelBase,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  minWidth: 230,
};

export const dataPanelTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

export const dataPanelRow: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

/** Two-column label/value grid for the live stream meter. */
export const streamMeter: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 10,
  rowGap: 2,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};

export const streamMeterValue: CSSProperties = {
  textAlign: 'right',
};

// --- omnigraph section of the Data panel ------

/** Sub-section under the stream controls, separated by a hairline rule. */
export const ogSection: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  borderTop: '1px solid var(--panel-border)',
  paddingTop: 8,
};

export const ogFieldRow: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

export const ogField: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 11,
  color: 'var(--fg-muted)',
};

export const ogInput: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--panel-border)',
  borderRadius: 6,
  background: 'var(--btn-bg)',
  color: 'var(--fg)',
  font: 'inherit',
  fontSize: 12,
  padding: '4px 7px',
  width: 72,
};

/** dataRef + counts block shown after a successful load. */
export const ogResult: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  maxWidth: 280,
};

export const ogWarning: CSSProperties = {
  color: '#f2cc60',
  fontSize: 11.5,
  overflowWrap: 'anywhere',
};

export const ogError: CSSProperties = {
  color: '#ff9b93',
  fontSize: 12,
  maxWidth: 280,
  overflowWrap: 'anywhere',
};

export const ogHint: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 11.5,
  marginTop: 4,
};

export const ogCode: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
  userSelect: 'all',
  overflowWrap: 'anywhere',
};

// --- Filters panel (soft filter + history controls) -------------------------

export const filtersPanel: CSSProperties = {
  ...panelBase,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  minWidth: 230,
};

export const filterClusterGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '4px 10px',
};

export const filterCheckLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export const filterModeRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 12,
};

export const filterVisibleLine: CSSProperties = {
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-soft)',
};

// --- Style panel (scales, theme, arrows/links toggles) ----------------------

export const stylePanel: CSSProperties = {
  ...panelBase,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  minWidth: 230,
};

export const styleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 12,
  flexWrap: 'wrap',
};

/** Label + select pair inside the Style panel. */
export const styleField: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  whiteSpace: 'nowrap',
};

export const select: CSSProperties = {
  border: '1px solid var(--panel-border)',
  borderRadius: 6,
  background: 'var(--btn-bg)',
  color: 'var(--fg)',
  font: 'inherit',
  fontSize: 12,
  padding: '4px 7px',
};

// --- M5 semantic-exploration surface (panel + right dock) -------------------

/** Control panel for the M5 mode; lives in the left header column under the
 * Style panel, so it inherits that column's scroll cap. */
export const m5Panel: CSSProperties = {
  ...panelBase,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  minWidth: 250,
  maxWidth: 300,
};

/**
 * Right dock hosting the two M5 equivalent views. It replaces the minimap /
 * legend float stack in this mode (both claim the right edge) and stops short
 * of the chart strip. `order` flips the visual stacking: the table renders
 * above the sim controls while the DOM keeps the controls first for the
 * keyboard walk.
 */
export const m5Dock: CSSProperties = {
  position: 'absolute',
  right: 14,
  top: 196,
  // Wide enough for the packaged components' intrinsic minimum (~362px) while
  // leaving the canvas band the e2e screenshot clip samples (x ≤ 880) clear.
  width: 380,
  // Below the three toolbar rows, above the chart strip.
  maxHeight: 'calc(100vh - 386px)',
  overflowY: 'auto',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const m5SimWrap: CSSProperties = {
  order: 1,
};

export const m5TableWrap: CSSProperties = {
  order: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

/** The packaged components bring their own chrome; these only neutralize the
 * panel's default absolute placement and let it fill the dock column. The
 * border-box override matters: the components pad and border themselves, so a
 * content-box `width: 100%` would overflow the dock by their chrome. */
export const m5SimControls: CSSProperties = {
  position: 'static',
  width: '100%',
  boxSizing: 'border-box',
};

export const m5Table: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
};

/** Two-column label/value grid of the M5 observables, docked under the table
 * (the left control column has no room for it at 800px viewports). */
export const m5Readouts: CSSProperties = {
  ...panelBase,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 10,
  rowGap: 2,
  padding: '8px 12px',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};

// --- legend (bottom-right, above the chart strip / status bar) --------------

/** Bottom-right float column: the minimap stacks ABOVE the legends, both
 * floating over the canvas (right edge, above the chart strip / status bar).
 * Carries the absolute positioning that used to live on `legendRow`. */
export const rightFloatStack: CSSProperties = {
  position: 'absolute',
  right: 14,
  bottom: 196,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 10,
};

/** Right-aligned legend row inside the float stack. Legends FLOAT over the
 * canvas instead of adding height to the bottom stack: in-flow they pushed
 * the chart strip below an 800px viewport (an e2e regression). Scroll
 * internally when very tall (cap leaves room for the minimap above). */
export const legendRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'flex-end',
  gap: 10,
  maxHeight: 'calc(100vh - 620px)',
  overflowY: 'auto',
};

/** Wrapper around <GraphMinimap> — pointer opt-in (overlayRoot is inert). */
export const minimapWrap: CSSProperties = {
  pointerEvents: 'auto',
};

/** Wrapper around <GraphLegend> — pointer opt-in (overlayRoot is inert). */
export const legendWrap: CSSProperties = {
  pointerEvents: 'auto',
  maxWidth: 320,
};

// --- chart strip (histogram + timeline, above the status bar) ----------------

/** Stacks the (collapsible) chart strip above the status-bar row. */
export const bottomStack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 8,
};

export const chartsToggleRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
};

export const chartStrip: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-end',
};

/** One chart cell of the strip. The packaged Histogram/Timeline components
 * bring their own panel chrome, so this is only sizing + pointer opt-in
 * (overlayRoot is pointer-inert). */
export const chartPanel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  pointerEvents: 'auto',
};

export const title: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: '0.04em',
};

export const counts: CSSProperties = {
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
};

export const toolbar: CSSProperties = {
  ...panelBase,
  display: 'flex',
  gap: 6,
  padding: 6,
  flexWrap: 'wrap',
};

/** Stacks the toolbar rows top-right (packaged toolbar, data row, selection). */
export const toolbarColumn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
};

/** One toolbar row: the packaged <GraphToolbar> beside the custom buttons. */
export const toolbarRow: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 8,
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
};

/** Style override handed to packaged overlay components so they sit inside
 * the demo's own flex rows instead of their default absolute positions
 * (overlayRoot is pointer-inert, so they opt back in here too). */
export const embeddedOverlay: CSSProperties = {
  position: 'static',
  pointerEvents: 'auto',
};

/** Muted inline hint inside a toolbar row (e.g. the pin-mode hint). */
export const toolbarHintText: CSSProperties = {
  alignSelf: 'center',
  padding: '0 6px',
  color: 'var(--fg-muted)',
  fontSize: 12,
  whiteSpace: 'nowrap',
};

export const button: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--panel-border)',
  borderRadius: 6,
  background: 'var(--btn-bg)',
  color: 'var(--fg)',
  font: 'inherit',
  fontSize: 12.5,
  padding: '6px 11px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export const bottomRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  gap: 12,
  flexWrap: 'wrap',
};

export const statusBar: CSSProperties = {
  ...panelBase,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '8px 13px',
  fontVariantNumeric: 'tabular-nums',
};

export const statusDot = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: color,
  flex: 'none',
});

export const statusMuted: CSSProperties = {
  color: 'var(--fg-muted)',
};

export const hint: CSSProperties = {
  ...panelBase,
  padding: '8px 13px',
  color: 'var(--fg-muted)',
  fontSize: 12,
};

export const errorBanner: CSSProperties = {
  ...panelBase,
  alignSelf: 'center',
  border: '1px solid rgba(248, 81, 73, 0.5)',
  color: '#ff9b93',
  padding: '8px 14px',
  maxWidth: 560,
};

export const selectionPanel: CSSProperties = {
  ...panelBase,
  position: 'absolute',
  // Below all three stacked toolbar rows (packaged toolbar + custom row +
  // selection actions) so it never covers their buttons.
  top: 180,
  right: 14,
  width: 210,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

/** "pinned · N" summary row at the top of the workbench sidebar. */
export const pinnedRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};

export const selectionHeader: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.03em',
  color: 'var(--fg-soft)',
  textTransform: 'uppercase',
  marginBottom: 2,
};

export const selectionRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
};

export const chip: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 3,
  flex: 'none',
};

export const selectionLabel: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};

export const selectionMore: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 12,
};

// --- collapsible navigator panel (left column, below the Data panel) --------

/** Lives inside the header column. FIRST in DOM (its toggle stays the page's
 * first tabbable element) but rendered LAST in the column via `order`, below
 * the header and the Data panel — Tab order follows DOM, not `order`. */
export const navigatorContainer: CSSProperties = {
  order: 3,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 8,
  pointerEvents: 'auto',
  maxHeight: '55vh',
};

export const navigatorPanel: CSSProperties = {
  ...panelBase,
  width: 280,
  padding: '10px 12px',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

// --- search (top-center, collapsible) ----------------------------------------

/** Floats the collapsible search box top-center. `top` clears the packaged
 * <GraphToolbar> band (the toolbar row reaches toward center-x at 1280px);
 * the container itself is pointer-INERT so its empty bounding box never
 * swallows toolbar/canvas clicks — the toggle and panel opt back in. */
export const searchContainer: CSSProperties = {
  position: 'absolute',
  top: 60,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  pointerEvents: 'none',
};

/** The search section's collapse toggle (pointer opt-in, see container). */
export const searchToggle: CSSProperties = {
  ...button,
  pointerEvents: 'auto',
};

/** Panel chrome around <GraphSearch> (the component itself is headless-ish).
 * panelBase opts back into pointer events. */
export const searchPanel: CSSProperties = {
  ...panelBase,
  padding: 8,
};

/** Omnigraph search result: decoded label, ellipsized to one line. */
export const searchResultText: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
  flex: 1,
};

/** The decoded Omnigraph `kind` prefix inside a search result row. */
export const searchResultKind: CSSProperties = {
  color: '#8ab4f8',
  fontWeight: 600,
};

/** Right-aligned score chip in a search result row. */
export const searchResultScore: CSSProperties = {
  marginLeft: 8,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
  flexShrink: 0,
};

// --- inspector (right dock, toggleable) --------------------------------------

/** Keeps the docked <GraphInspector> clear of the top-right toolbar rows and
 * the bottom chart strip / status bar. */
export const inspectorOverride: CSSProperties = {
  top: 180,
  bottom: 240,
  right: 14,
};

// --- CSV drop (prepared-data lane) ----------------------------------------

export const csvPanel: CSSProperties = {
  ...panelBase,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  minWidth: 230,
  maxWidth: 280,
};

export const csvHint: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 11.5,
};

/** Visually hidden but layout-present file input (1×1, opacity 0) — Playwright
 * `setInputFiles` needs an attached input with a box; `display:none` is out. */
export const csvHiddenInput: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  border: 0,
  opacity: 0,
  overflow: 'hidden',
};

export const csvSummary: CSSProperties = {
  fontSize: 11.5,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-soft)',
  overflowWrap: 'anywhere',
};

/** Full-window drag overlay shown only while a file drag is over the window.
 * Pointer-inert: the window-level listeners own dragover/drop. */
export const csvDropOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.45)',
  pointerEvents: 'none',
};

export const csvDropOverlayInner: CSSProperties = {
  ...panelBase,
  border: '2px dashed var(--fg-muted)',
  padding: '28px 44px',
  fontSize: 16,
  letterSpacing: '0.04em',
};


// --- node label pills --------------------------------------------------------
// The label lane renders ONE positioned div per label; these styles shape
// what goes inside it via <Graph renderNodeLabel>. Two things carry the
// readability win: the width CLAMP (an untruncated title is what turns a dense
// graph into a wall of text — far more than colour) and the scrim, which
// separates each label from the node cloud behind it.
//
// Colours come from the theme custom properties merged onto the app root
// (themeVars), NOT hardcoded rgba: <Graph> renders inside that container, so
// the vars inherit down to every label div and the pill follows the dark/light
// toggle for free.

/** Cap the run and ellipsize instead of letting titles run on forever. */
const labelClamp: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** The pill itself: a scrim behind the text, sized to its content. */
export const labelPill: CSSProperties = {
  ...labelClamp,
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 5,
  maxWidth: 280,
  padding: '1px 7px',
  borderRadius: 5,
  background: 'var(--panel-bg)',
  border: '1px solid var(--panel-border)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
};

/** The node's own name — the thing you actually read. */
export const labelPillName: CSSProperties = {
  ...labelClamp,
  color: 'var(--fg-soft)',
  fontWeight: 500,
};

/** The adapter-injected kind: present but demoted, so it never competes with
 * the name. Hidden entirely when the Style panel's toggle is off.
 *
 * Deliberately NOT width-clamped: kinds are a closed vocabulary, and a
 * truncated one ("INFORMATIO…") conveys nothing while still stealing the
 * name's space — show it whole or hide it with the toggle. `flex: 0 0 auto`
 * keeps it from being squeezed; the NAME absorbs the remaining width. */
export const labelPillType: CSSProperties = {
  whiteSpace: 'nowrap',
  flex: '0 0 auto',
  color: 'var(--fg-muted)',
  fontSize: '0.72em',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

/** fold badge — "this node is standing for N others". Reads as a count
 * chip rather than more label text: tabular digits so the width does not
 * jitter as the count changes, and never clamped (a truncated count is worse
 * than useless). */
export const labelPillBadge: CSSProperties = {
  whiteSpace: 'nowrap',
  flex: '0 0 auto',
  padding: '0 4px',
  borderRadius: 4,
  background: 'var(--accent-soft, rgba(120, 160, 255, 0.22))',
  color: 'var(--fg-soft)',
  fontSize: '0.72em',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
};

/** deep-link mismatch banner: fixed top, above every overlay. */
export const mismatchBanner: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 14px',
  borderRadius: '0 0 8px 8px',
  background: 'var(--panel-bg)',
  border: '1px solid var(--panel-border)',
  color: 'var(--fg-soft)',
  font: '12px/1.4 system-ui, sans-serif',
};

export const mismatchButton: CSSProperties = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid var(--panel-border)',
  background: 'var(--btn-bg)',
  color: 'var(--fg-soft)',
  cursor: 'pointer',
  font: 'inherit',
};
