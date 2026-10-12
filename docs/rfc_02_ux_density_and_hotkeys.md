# RFC 02: High-Density UX, 3-Pane Topology, and Hotkey Focus Architecture

| Metadata | Value |
| :--- | :--- |
| **Status** | Design document, updated 2026-10-11 to match what's built |
| **Author** | Testify Architecture Team |
| **Date** | September 8, 2026 |
| **Target Release** | v1.0 Enterprise Baseline |
| **Upstream Requirements** | [`00_requirements_alignment.md`](00_requirements_alignment.md), [UX Ergonomics Spec](../.antigravity/agents/ux_ergonomics.md) |

---

## 1. Executive Summary & Philosophy

TestLink's primary operational flaw is fragmented navigation requiring multi-page frame reloads to view steps or log execution outcomes. For QA engineers running hundreds of repetitive tests daily, mouse dependency and slow UI response create severe bottlenecks.

**RFC 02** defines the UI/UX design tokens, layout topology, data-density guidelines, keyboard-first navigation model, focus state machine, and collision-free hotkey architecture for Testify. 

### Core Objectives
1. **Zero-Latency Execution:** Instantaneous (<50ms) UI updates upon keypress with optimistic local state rendering.
2. **Keyboard-First Workflow:** Moving through the queue, recording verdicts and writing notes without touching the mouse. (Step-by-step verdicts and defect linking were planned but aren't built.)
3. **High-Density Workspace:** Strict **32px row height** tabular layout and **28px tree node** standard to maximize visible screen real estate.
4. **Collision-Free Ergonomics:** Automatic deactivation of single-key shortcuts when typing in inputs/textareas without requiring manual `Esc` disengagement.

---

## 2. 3-Pane Topology Layout Specification

The workspace has three panes side by side, separated by draggable dividers.

```
+---------------------------------------------------------------------------------------------------------+
| HEADER: Project ▾ ➕✏️🗑️ | Test Plan ▾ ➕✏️🗑️ | Test Run ▾ ➕✏️🗑️ | Import | Export | Reports | Admin | User |
+----------------------------------+------------------------------------+---------------------------------+
| PANE 1: Suite Tree               | PANE 2: Case List / Queue          | PANE 3: Detail                  |
| (default 280px, draggable)       | (default 420px, draggable)         | (the rest)                      |
|----------------------------------+------------------------------------+---------------------------------|
| [ Execute | Spec ]               | Spec: + Case, case list with       | Spec: case editor (title,       |
| Search ID, title or suite (/)    | status boxes and + Add / In Plan   | priority, version, steps,       |
| + Filter  (property → value)     |                                    | custom fields) or Suite Details |
| v Auth Suite          [12/15]    | Execute: queue with verdict        | Execute: steps, custom fields   |
|   > OAuth2            [ 4/4 ]    | letters (P F B S, - untested)      | (read-only), verdict buttons,   |
|   v Token Refresh     [ 1/2 ]    |                                    | notes, hotkey badge             |
+----------------------------------+------------------------------------+---------------------------------+
```

### 2.1 Pane Functionality & Sizing Metrics

| Pane | Role | Width | Contents |
| :--- | :--- | :--- | :--- |
| **Pane 1** | Suite tree | Default `280px`, at least `140px` | Execute/Spec toggle; search and filter rows; the suite tree with counts, plan-inclusion toggles (Spec) or pass/fail pills (Execute); create, rename and delete buttons; drag-and-drop moving in Spec mode. |
| **Pane 2** | Case list (Spec) or execution queue (Execute) | Default `420px`, at least `180px` | Virtualized list. Spec: version status boxes and plan toggles. Execute: verdict letters and the selected-suite filter. |
| **Pane 3** | Details | The rest, at least `160px` | Spec: the case editor or Suite Details. Execute: the case's steps and custom fields, verdict buttons, notes and the hotkey badge. |

The widths reset to the defaults on every load; they aren't saved.

### 2.2 Responsive & Collapsible Behavior

Not built. The design was:
- below 1280px, Pane 1 collapses into a slide-out drawer;
- below 1024px, one pane at a time with a tab switcher.

The layout is desktop-only today.

### 2.3 Modes and Views

- **Spec mode** (the default on load): browse and edit suites and cases, and curate which cases are in the selected plan.
- **Execute mode:** record results for the selected run. A user without `SPEC_VIEW` is kept in Execute mode, and the toggle is disabled.
- **Reports** replaces the three panes with a full-width view (Overview, Run, Trends, Health, Scheduled Emails), with shareable `#/reports/...` links. "← Back to workspace" returns to the panes.

---

## 3. Data Density & Design System Standards

To eliminate visual waste and maximize screen capacity, the UI enforces explicit pixel-grid density guidelines.

### 3.1 Row Density Specifications

```
+-----------------------------------------------------------------------+
| 32px Standard Grid Row (Pane 2 Test Case List & Pane 3 Step Table)    |
| +--- Top Padding: 4px                                               + |
| | Badge (20px) | ID: TC-104 (13px) | Title Text... | Priority Badge  | |
| +--- Bottom Padding: 4px                                            + |
+-----------------------------------------------------------------------+
| 28px Tree Node Row (Pane 1 Recursive Navigation Tree)                 |
| +--- Top Padding: 3px                                               + |
| | [v] Folder Icon (16px) | Suite Title...          | Pill (18px)    | |
| +--- Bottom Padding: 3px                                            + |
+-----------------------------------------------------------------------+
```

- **Pane 2 Grid Rows:** `32px` in the Execute queue; `38px` in the Spec case list, which shows more per row.
- **Pane 1 Tree Rows:** Height locked to `28px`. Folder/suite icons `16px x 16px`. Indentation `12px` per hierarchy level.
- **Step Table Rows (Pane 3):** Min-height `32px`, expanding dynamically only when multiline actual results or long payload steps are present.

### 3.2 Virtualized List Rendering (5,000+ Items)

The suite tree and both case lists render only the rows in view, plus a buffer of 10 rows above and below (hand-rolled windowing, no library). Their DOM size doesn't grow with the number of cases, and `j`/`k` scrolls the selected row into view.

### 3.3 CSS Variables & Design Tokens Reference

The design called for these tokens. The app doesn't use CSS variables yet: components use inline styles with the same kinds of values (dark theme, blue `#3b82f6` focus and selection, amber warning banners).

```css
:root {
  /* Layout Dimensions */
  --pane-1-width-default: 300px;
  --pane-1-width-min: 260px;
  --pane-1-width-max: 340px;
  --pane-2-width-default: 420px;
  --pane-2-width-min: 380px;
  --pane-2-width-max: 480px;

  /* Density & Row Heights */
  --density-row-height-grid: 32px;
  --density-row-height-tree: 28px;
  --density-padding-y: 4px;
  --density-padding-x: 8px;

  /* Typography */
  --font-family-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --font-family-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-base: 13px;
  --font-size-lg: 14px;

  /* Focus & High-Contrast Borders */
  --border-radius-sm: 2px;
  --border-radius-md: 4px;
  --focus-ring-color: #3b82f6; /* Blue-500 */
  --focus-ring-width: 2px;
  --active-row-bg: rgba(59, 130, 246, 0.12);
  --active-row-border: #2563eb;
}
```

---

## 4. Master Hotkey Matrix & Keybinding Specification

All shortcuts work out of the box; they can't be remapped. The implementation is `apps/web/src/hooks/useHotkeyEngine.ts`.

| Key | Action | Where | Behavior |
| :--- | :--- | :--- | :--- |
| `j` / ↓ | Next case | Both modes | Moves the selection down one row. |
| `k` / ↑ | Previous case | Both modes | Moves the selection up one row. |
| `[` | Collapse the tree | Both modes | Collapses the suite tree. |
| `]` | Expand the tree | Both modes | Expands the suite tree. |
| `/` | Search | Both modes | Focuses the search box in Pane 1; hotkeys pause while typing. |
| `Esc` | Leave a text box | Any input | Blurs it; hotkeys re-engage. In Spec mode, also clears a multi-selection. |
| `p` | Passed | Execute | Records PASSED and moves to the next case (into the next suite at the end of one). |
| `f` | Failed | Execute | Records FAILED and focuses the notes box. |
| `b` | Blocked | Execute | Records BLOCKED and focuses the notes box. |
| `s` | Skipped | Execute | Records SKIPPED and moves to the next case. |
| `Ctrl+Enter` | Save notes | Execute, in the notes box | Records the case's current verdict again with the notes, then jumps to the first case of the next suite. |

The verdict keys and `Ctrl+Enter` are refused, with a message, in these cases:
- in Spec mode;
- when no run is selected or the run is closed;
- for a case removed from the plan;
- without `EXECUTE_RUN`;
- or, for a case that already has a result, without `EXECUTE_OVERWRITE`. Re-sending your own latest verdict with notes is still allowed.

---

## 5. Keyboard Focus Container & State Machine

Keybinding conflicts are eliminated via a central **Keyboard Focus Manager** operating as a strict Finite State Machine (FSM).

### 5.1 Focus Zones

1. **Zone 1: Navigation Tree (`TREE`)** - Focus is inside Pane 1. Arrow keys navigate suites.
2. **Zone 2: Test Case Queue (`LIST`)** - Focus is inside Pane 2 table. `j`/`k` move selection up/down.
3. **Zone 3: Execution Workspace (`EXECUTION_CONTAINER`)** - Focus is inside Pane 3 execution container. **Single-key verdict hotkeys (`p`,`f`,`b`,`s`) are ACTIVE.**
4. **Zone 4: Input / Editing Form (`TEXT_INPUT`)** - User is typing inside `<input>`, `<textarea>`, or `contenteditable`. **Single-key hotkeys are AUTOMATICALLY DEACTIVATED.**
5. **Zone 5: Modal (`MODAL`)** - A dialog is open; only `Esc` is handled.

As built, the hotkeys don't depend on which pane has focus. `TREE` and `LIST` exist in the state machine (`useFocusFSM.ts`), but nothing switches to them, and arrow keys in the tree aren't built. What matters is whether a text box (`TEXT_INPUT`) or a dialog (`MODAL`) has focus, so the diagram below is the design rather than the exact behavior.

### 5.2 State Transition Diagram

```
                       +------------------------+
                       |   GLOBAL SEARCH (/)    |
                       +-----------+------------+
                                   | (Esc)
                                   v
   +-------------------+  (Tab / Click)   +-------------------+
   | ZONE 1: TREE      | <--------------> | ZONE 2: LIST      |
   +---------+---------+                  +---------+---------+
             |                                      |
             | (Enter / Arrow-Right)                | (Enter / Right)
             v                                      v
   +----------------------------------------------------------+
   | ZONE 3: EXECUTION CONTAINER (Hotkeys ACTIVE)             |
   | Active Shortcuts: p, f, b, s, j, k                       |
   +----------------------------+-----------------------------+
                                |
        +-----------------------+-----------------------+
        | (Focus into input)                            | (Press 'f' or 'b')
        v                                               v
   +----------------------------------------------------------+
   | ZONE 4: TEXT INPUT / FORM EDITING                        |
   | (Hotkeys AUTO-DEACTIVATED; Ctrl+Enter to submit)         |
   +----------------------------+-----------------------------+
                                |
                                | (Blur input / Press Ctrl+Enter / Press Esc)
                                v
   +----------------------------------------------------------+
   | ZONE 3: EXECUTION CONTAINER (Hotkeys RE-ENGAGED)         |
   +----------------------------------------------------------+
```

### 5.3 Collision Protection & Permission Gating (No `Esc` Required)

As locked in [`00_requirements_alignment.md`](00_requirements_alignment.md) and aligned with [`rfc_04_rbac_security_matrix.md`](rfc_04_rbac_security_matrix.md):
- **Permission gate:**
  - Verdict hotkeys check the current user's permissions in the selected project (`useFocusFSM`).
  - Without `EXECUTE_RUN`, the hotkey badge shows `READ ONLY`, and pressing a verdict key shows a yellow "Not permitted" banner instead of recording anything.
  - Re-recording a case that already has a result needs `EXECUTE_OVERWRITE`.
  - The server checks all of this too, so the buttons and the API can't get around it.
- **Automatic input deactivation:** whenever an `<input>`, `<textarea>`, `<select>` or `contenteditable` element has focus, single-key hotkeys are ignored. Typing "p" in the notes box types a "p".
- **Automatic re-engagement:** when focus leaves the input, hotkeys work again without pressing `Esc`.
- **Recording:**
  - Every verdict key records a result immediately (`POST /api/v1/executions`, status `COMPLETED`).
  - `f` and `b` then focus the notes box. `Ctrl+Enter` records the same verdict again with the notes and moves on.
  - There's no "in progress" state.

## 6. Visual Hotkey Toggle Indicator

To remove ambiguity about whether keypresses will record verdicts or type characters, Pane 3 in Execute mode shows a **hotkey badge** (`FocusIndicatorBadge`). Clicking it turns hotkeys off or back on.

```
+-------------------------------------------------------------------------------+
| PANE 3: TC-104 - OAuth2 PKCE Token Exchange      [ HOTKEYS: ACTIVE (ON) ]   |
+-------------------------------------------------------------------------------+
```

### 6.1 Status Indicator States

| State | Badge Visual Style | Tooltip / Sub-Text | Hotkey Engine Status |
| :--- | :--- | :--- | :--- |
| **ACTIVE** | Solid Green Pill (`#16a34a`) with white text `[⚡ HOTKEYS: ON]` | Single-key shortcuts `p, f, b, s, j, k` active. | Listening & executing. |
| **READ ONLY** | Dark red pill | The user lacks `EXECUTE_RUN`. | Verdict keys refused; navigation works. |
| **TYPING PAUSED** | Amber Pill (`#d97706`) with text `[✏️ TYPING MODE]` | Hotkeys auto-paused while typing. Press `Ctrl+Enter` or click outside to re-engage. | Paused (Input Focused). |
| **MANUALLY OFF** | Dark Gray Outline Pill (`#4b5563`) `[🔒 HOTKEYS: OFF]` | Single-key hotkeys manually disabled by user toggle. | Disabled. |

---

## 7. Execution Interaction Flow & Optimistic UI

### 7.1 Flows

**Pass / Skip (`p` / `s`):**
1. The queue shows the new verdict at once (optimistic update), and the result is sent (`POST /api/v1/executions`).
2. The selection moves to the next case. At the end of a suite filter, it moves into the next suite.

**Fail / Block (`f` / `b`):**
1. The verdict is shown and recorded at once, and the notes box is focused (hotkeys pause while typing).
2. The user types what went wrong.
3. `Ctrl+Enter` records the verdict again with the notes, re-engages hotkeys, and jumps to the first case of the next suite.

### 7.2 Optimistic UI

- The queue updates before the server answers; state lives in React hooks (`useExecution`), with no separate store.
- **Rollback:** if the server refuses the result (e.g. 403, a closed run) or the request fails, the case's previous verdict and notes come back. A permission refusal shows the yellow "Not permitted" banner; other failures show a toast.
- There's no offline queue or automatic retry.

## 8. Accessibility & High-Density Color Palette

Verdicts are never shown by color alone: each has a letter (`P`, `F`, `B`, `S`, and `-` for untested), so they work for colorblind users. The app has only a dark theme; the light-mode colors below were designed but aren't used, and the contrast ratios haven't been measured.

### 8.1 Verdict Visual Badge Specification

| Verdict State | Character | Light Mode Color | Dark Mode Color | Border / Accent | WCAG Ratio |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Passed** | `P` | Background: `#dcfce7`<br>Text: `#15803d` | Background: `#052e16`<br>Text: `#4ade80` | Solid Emerald `#22c55e` | 7.2:1 |
| **Failed** | `F` | Background: `#fee2e2`<br>Text: `#b91c1c` | Background: `#450a0a`<br>Text: `#f87171` | Solid Red `#ef4444` | 7.5:1 |
| **Blocked** | `B` | Background: `#fef3c7`<br>Text: `#b45309` | Background: `#451a03`<br>Text: `#fbbf24` | Solid Amber `#f59e0b` | 7.1:1 |
| **Skipped** | `S` | Background: `#f3f4f6`<br>Text: `#4b5563` | Background: `#1f2937`<br>Text: `#9ca3af` | Solid Gray `#6b7280` | 8.0:1 |
| **Untested** | `U` / `-` | Background: `#ffffff`<br>Text: `#9ca3af` | Background: `#111827`<br>Text: `#6b7280` | Dashed `#d1d5db` | 6.5:1 |

### 8.2 Dark Mode Theme Tokens

```css
[data-theme="dark"] {
  --bg-app: #090d16;
  --bg-pane-1: #0d111c;
  --bg-pane-2: #111827;
  --bg-pane-3: #0d111c;
  --bg-row-hover: #1f2937;
  --bg-row-active: rgba(59, 130, 246, 0.2);
  
  --text-primary: #f9fafb;
  --text-secondary: #9ca3af;
  --text-muted: #6b7280;
  
  --border-color: #1f2937;
  --border-focus: #3b82f6;
  
  --verdict-pass-bg: #052e16;
  --verdict-pass-fg: #4ade80;
  --verdict-fail-bg: #450a0a;
  --verdict-fail-fg: #f87171;
  --verdict-block-bg: #451a03;
  --verdict-block-fg: #fbbf24;
  --verdict-skip-bg: #1f2937;
  --verdict-skip-fg: #9ca3af;
}
```

---

## 9. Status

| Requirement | Status |
| :--- | :--- |
| **3-pane layout** with draggable dividers | Built. Sizes differ from the original design (§2.1); responsive layouts not built. |
| **Row heights:** 32px queue rows, 28px tree rows | Built; the Spec case list uses 38px. |
| **Hotkeys** `j k [ ] / p f b s Esc Ctrl+Enter` | Built; covered by `apps/web/src/tests/hotkeys.test.ts`. |
| **Hotkeys pause while typing** | Built. |
| **Hotkey badge** (ACTIVE, TYPING MODE, READ ONLY, OFF) | Built. |
| **Letter verdict badges** | Built; dark theme only. |
| **Step-level verdicts, defect linking, light theme** | Not built. |

## 10. Summary

RFC 02 set out a high-density, keyboard-first workspace for QA execution. The core of it is built: three panes, virtualized lists, single-key verdicts with typing protection, and permission gating. The open items are in §9.
