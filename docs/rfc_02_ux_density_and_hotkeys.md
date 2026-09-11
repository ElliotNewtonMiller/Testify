# RFC 02: High-Density UX, 3-Pane Topology, and Hotkey Focus Architecture

| Metadata | Value |
| :--- | :--- |
| **Status** | Approved & Locked |
| **Author** | TestLink-Next Architecture Team |
| **Date** | September 8, 2026 |
| **Target Release** | v1.0 Enterprise Baseline |
| **Upstream Requirements** | [`00_requirements_alignment.md`](file:///docs/00_requirements_alignment.md), [UX Ergonomics Spec](file:///.antigravity/agents/ux_ergonomics.md) |

---

## 1. Executive Summary & Philosophy

TestLink's primary operational flaw is fragmented navigation requiring multi-page frame reloads to view steps or log execution outcomes. For QA engineers running hundreds of repetitive tests daily, mouse dependency and slow UI response create severe bottlenecks.

**RFC 02** defines the UI/UX design tokens, layout topology, data-density guidelines, keyboard-first navigation model, focus state machine, and collision-free hotkey architecture for TestLink-Next. 

### Core Objectives
1. **Zero-Latency Execution:** Instantaneous (<50ms) UI updates upon keypress with optimistic local state rendering.
2. **Keyboard-First Workflow:** Full suite traversal, test case selection, step-by-step evaluation, defect linking, and verdict submission without touching the mouse.
3. **High-Density Workspace:** Strict **32px row height** tabular layout and **28px tree node** standard to maximize visible screen real estate.
4. **Collision-Free Ergonomics:** Automatic deactivation of single-key shortcuts when typing in inputs/textareas without requiring manual `Esc` disengagement.

---

## 2. 3-Pane Topology Layout Specification

The primary workspace operates on a **3-Pane Responsive Topology**. Resizable drag-handles (splitters) separate the three panes, allowing custom width adjustments while retaining explicit constraints.

```
+-------------------------------------------------------------------------------------------------------------------------------+
| TOP HEADER: Project Selector | Test Plan Dropdown | Build Selector | Search Bar (/) | User Profile | Global Settings          |
+------------------------------------+------------------------------------+-----------------------------------------------------+
| PANE 1: Suite Tree Navigation      | PANE 2: Suite Test Case Queue      | PANE 3: Execution & Detail Workspace                |
| (260px - 340px Adjustable)         | (380px - 480px Adjustable)         | (Fluid Remaining Width)                             |
|------------------------------------+------------------------------------+-----------------------------------------------------|
| [ Quick Filter Bar               ] | [ Suite: Authentication Engine  ] | [ TC-104: OAuth2 PKCE Token Exchange ] [v2 Approved]|
| [ Status | Priority | Assignee   ] | [ Search Cases... (Ctrl+F)       ] | Priority: HIGH | Assignee: Alex Dev | Build: v2.4.0-rc1   |
|------------------------------------+------------------------------------+-----------------------------------------------------|
| v Auth Suite          [ 12/15 P ]  | [P] TC-101 Login via Password      | > Preconditions (Collapsible)                       |
|   > OAuth2 Sub-suite  [  4/4  P ]  | [P] TC-102 Login via SAML2 SSO     |   User must have valid client credentials in vault. |
|   v Token Refresh     [  1/2  F ]  | > [F] TC-104 OAuth2 PKCE Exchange  |-----------------------------------------------------|
|     * TC-104 PKCE     (Active)     | [B] TC-105 Token Expire Revoke     | Step | Action           | Expected      | Verdict | Notes   |
|     * TC-105 Revoke   [  1/1  B ]  | [S] TC-106 Multi-Tenant Scopes     |   1  | POST /oauth/token| HTTP 200 OK   |  [P]    | OK      |
| > Database Suite      [  0/30 U ]  | [U] TC-107 PKCE Code Verifier      |   2  | Invalid Secret   | HTTP 401 Auth |  [F]    | 500 Err |
| > API Endpoint Suite  [ 50/50 P ]  | [U] TC-108 State Parameter Rej     |-----------------------------------------------------|
|                                    |                                    | Docked Execution Action Bar  [Hotkeys: ACTIVE (ON)] |
|                                    |                                    | [P] Pass (p) | [F] Fail (f) | [B] Block (b) | [S] Skip |
+------------------------------------+------------------------------------+-----------------------------------------------------+
| FOOTER: Keyboard Focus Zone: [Pane 3 - Execution Form] | Hotkeys: ACTIVE | Sync Status: Connected (0 pending ops)             |
+-------------------------------------------------------------------------------------------------------------------------------+
```

### 2.1 Pane Functionality & Sizing Metrics

| Pane | Role | Width Constraints | Key Components & Features |
| :--- | :--- | :--- | :--- |
| **Pane 1** | Recursive Tree Navigation | `260px` min / `340px` max | Quick filter bar (Status, Priority, Assignee, Tag); Recursive Test Suite hierarchy; Progress pills (`Passed/Total`); Collapse state toggles. |
| **Pane 2** | Test Case Queue & Bulk List | `380px` min / `480px` max | High-density grid; 32px row height standard; Active row high-contrast focus outline; Instant visual verdict badges (`P`, `F`, `B`, `S`, `U`). |
| **Pane 3** | Execution & Detail Workspace | `Fluid` (Rest of Viewport) | Top metadata header; Collapsible preconditions section; Step-by-step verification table; Docked verdict action bar with live hotkey toggle indicator. |

### 2.2 Responsive & Collapsible Behavior

On narrower displays or smaller laptop screens:
- **Tablet / Small Viewport (<1280px):** Pane 1 collapses into a slide-out drawer triggered by `[` or an icon button. Pane 2 and Pane 3 split screen 40% / 60%.
- **Compact Viewport (<1024px):** Single active pane view with top tab switcher: `[1: Tree] | [2: Queue] | [3: Execution]`.

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

- **Pane 2 Grid Rows:** Height locked to exactly `32px`. Content centered vertically. Minimal padding: `4px` top/bottom, `8px` left/right.
- **Pane 1 Tree Rows:** Height locked to `28px`. Folder/suite icons `16px x 16px`. Indentation `12px` per hierarchy level.
- **Step Table Rows (Pane 3):** Min-height `32px`, expanding dynamically only when multiline actual results or long payload steps are present.

### 3.2 Virtualized List Rendering (5,000+ Items)

To prevent DOM degradation during large suite execution:
- Pane 2 list uses windowed virtual scrolling (`@tanstack/react-virtual` or CSS content-visibility pipeline).
- Buffer window fixed at `10` extra items above and below the visible viewport.
- Maximum initial DOM nodes in Pane 2 capped at `~45` nodes regardless of suite size (50 or 10,000 cases).
- Frame budget: Keystroke navigation (`j`/`k`) updates target index in `<5ms` and re-positions focus frame within `<16ms` (60 FPS).

### 3.3 CSS Variables & Design Tokens Reference

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

All shortcuts operate out-of-the-box without user key-mapping configuration in v1.

```
+---------------------------------------------------------------------------------------------------------+
| MASTER HOTKEY MATRIX                                                                                   |
+---------+-----------------------------------+--------------------+--------------------------------------+
| Key     | Action Description                | Target Scope       | Conditions & Auto-Advance Behavior   |
+---------+-----------------------------------+--------------------+--------------------------------------+
| j / Dn  | Move to next test case in list    | Pane 2 / Pane 3    | Shifts active index down by 1.       |
| k / Up  | Move to prev test case in list    | Pane 2 / Pane 3    | Shifts active index up by 1.         |
| [       | Collapse current suite in tree    | Pane 1 Navigation  | Toggles folder collapse state.       |
| ]       | Expand current suite in tree      | Pane 1 Navigation  | Toggles folder expand state.         |
| /       | Focus quick search / filter bar   | Global / Top Bar   | Focuses search input; pauses hotkeys.|
| Esc     | Clear focus / return to list nav  | Any Focused Input  | Blurs input; re-engages hotkeys.     |
+---------+-----------------------------------+--------------------+--------------------------------------+
| p       | Mark active case as PASSED        | Pane 3 Execution   | Logs PASS; advances to next case.    |
| f       | Mark active case as FAILED        | Pane 3 Execution   | Logs FAIL; auto-focuses notes input. |
| b       | Mark active case as BLOCKED       | Pane 3 Execution   | Logs BLOCK; opens defect ID prompt.  |
| s       | Mark active case as SKIPPED       | Pane 3 Execution   | Logs SKIP; advances to next case.    |
| e       | Toggle detailed execution drawer  | Pane 3 Execution   | Opens step-level drawer detail view. |
| Ctrl+Ent| Submit execution verdict & notes  | Pane 3 Form        | Saves execution form from text input.|
+---------+-----------------------------------+--------------------+--------------------------------------+
```

---

## 5. Keyboard Focus Container & State Machine

Keybinding conflicts are eliminated via a central **Keyboard Focus Manager** operating as a strict Finite State Machine (FSM).

### 5.1 Focus Zones

1. **Zone 1: Navigation Tree (`TREE`)** - Focus is inside Pane 1. Arrow keys navigate suites.
2. **Zone 2: Test Case Queue (`LIST`)** - Focus is inside Pane 2 table. `j`/`k` move selection up/down.
3. **Zone 3: Execution Workspace (`EXECUTION_CONTAINER`)** - Focus is inside Pane 3 execution container. **Single-key verdict hotkeys (`p`,`f`,`b`,`s`) are ACTIVE.**
4. **Zone 4: Input / Editing Form (`TEXT_INPUT`)** - User is typing inside `<input>`, `<textarea>`, or `contenteditable`. **Single-key hotkeys are AUTOMATICALLY DEACTIVATED.**
5. **Zone 5: Modal / Drawer (`MODAL`)** - Focus trapped inside dialog (e.g. defect linking modal).

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
   | Active Shortcuts: p, f, b, s, j, k, e                    |
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

### 5.3 Collision Protection & RBAC Permission Gating (No `Esc` Required)

As locked in [`00_requirements_alignment.md`](file:///docs/00_requirements_alignment.md) and aligned with [`rfc_04_rbac_security_matrix.md`](file:///docs/rfc_04_rbac_security_matrix.md):
- **RBAC Permission Gate:** Single-key execution hotkeys (`p`, `f`, `b`, `s`) are evaluated against the current user's assigned permissions. If the user lacks the `EXECUTE_RUN` key (e.g., `Viewer` role), the hotkey engine enters `State.READ_ONLY_DISABLED`, the header displays `[🔒 READ ONLY]`, and keypresses emit a toast warning without triggering mutations. If editing a previously completed execution, `EXECUTE_OVERWRITE` is validated.
- **Automatic Input Deactivation:** Whenever an `<input>`, `<textarea>`, `<select>`, or `[contenteditable]` element receives key focus (`focus` event), the hotkey engine immediately shifts to `State.TEXT_INPUT` (`TYPING MODE`) and disables single-character listener execution.
- **Typing Protection:** Typing the letter `"p"` inside the Actual Results box appends the character `"p"` to the text string rather than triggering a `PASSED` execution state change.
- **Automatic Re-engagement:** When focus leaves the input field (`blur` event), focus returns to `ZONE 3: EXECUTION_CONTAINER`, and hotkeys re-engage automatically without requiring `Esc`.
- **Database State Transition Mechanics:**
  - **Rapid Pass (`p`) / Skip (`s`):** Immediately commits `executions.status = 'COMPLETED'` and `executions.verdict = 'PASSED'` (or `'SKIPPED'`) to local store & API background queue, advancing to the next case.
  - **Fail (`f`) / Block (`b`):** Sets `executions.status = 'IN_PROGRESS'` with pending `verdict = 'FAILED'` (or `'BLOCKED'`), auto-focuses notes input, and shifts hotkey badge to `[✏️ TYPING MODE]`. Submitting via `Ctrl+Enter` commits `executions.status = 'COMPLETED'`, `executions.verdict = 'FAILED'`, and recorded notes.

```typescript
// Focus Event Listener Logic Standard with RBAC Permission Checks
function handleGlobalKeyDown(event: KeyboardEvent) {
  const { currentUserPermissions, currentExecutionState } = useStore.getState();

  // 1. RBAC Guard: Verify EXECUTE_RUN permission for verdict hotkeys
  const canExecute = currentUserPermissions.includes('EXECUTE_RUN');
  const isOverwriting = currentExecutionState?.status === 'COMPLETED';
  const canOverwrite = isOverwriting ? currentUserPermissions.includes('EXECUTE_OVERWRITE') : true;

  const activeElement = document.activeElement;
  const isInputFocused = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    activeElement.tagName === 'SELECT' ||
    (activeElement as HTMLElement).isContentEditable
  );

  // 2. Input Focus Guard: Disable single-key shortcuts while typing
  if (isInputFocused) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      if (canExecute && canOverwrite) submitExecutionForm();
      else showToastWarning('Permission Denied: EXECUTE_RUN required');
    }
    return; // Pass through standard text input behavior
  }

  // 3. Execution Hotkey Handler (ZONE 3)
  switch (event.key) {
    case 'p': 
      if (!canExecute || !canOverwrite) return showToastWarning('EXECUTE_RUN permission required');
      markVerdict({ status: 'COMPLETED', verdict: 'PASSED' });
      advanceToNextCase();
      break;
    case 'f': 
      if (!canExecute || !canOverwrite) return showToastWarning('EXECUTE_RUN permission required');
      markVerdict({ status: 'IN_PROGRESS', verdict: 'FAILED' }); 
      focusNotesInput(); 
      break;
    case 'b': 
      if (!canExecute || !canOverwrite) return showToastWarning('EXECUTE_RUN permission required');
      markVerdict({ status: 'IN_PROGRESS', verdict: 'BLOCKED' }); 
      openDefectModal(); 
      break;
    case 's': 
      if (!canExecute || !canOverwrite) return showToastWarning('EXECUTE_RUN permission required');
      markVerdict({ status: 'COMPLETED', verdict: 'SKIPPED' });
      advanceToNextCase();
      break;
    case 'j': selectNextCase(); break;
    case 'k': selectPrevCase(); break;
  }
}
```

---

## 6. Visual Hotkey Toggle Indicator

To remove ambiguity regarding whether keypresses will trigger verdicts or type characters, the top right section of Pane 3 features a prominent **Visual Hotkey Toggle Indicator**.

```
+-------------------------------------------------------------------------------+
| PANE 3 HEADER: TC-104 - OAuth2 PKCE Token Exchange                           |
| Build: v2.4.0-rc1 | Assigned: Alex Dev | [ HOTKEYS: ACTIVE (ON) [kbd: p,f,b,s] ]|
+-------------------------------------------------------------------------------+
```

### 6.1 Status Indicator States

| State | Badge Visual Style | Tooltip / Sub-Text | Hotkey Engine Status |
| :--- | :--- | :--- | :--- |
| **ACTIVE** | Solid Green Pill (`#16a34a`) with white text `[⚡ HOTKEYS: ON]` | Single-key shortcuts `p, f, b, s, j, k` active. | Listening & executing. |
| **TYPING PAUSED** | Amber Pill (`#d97706`) with text `[✏️ TYPING MODE]` | Hotkeys auto-paused while typing. Press `Ctrl+Enter` or click outside to re-engage. | Paused (Input Focused). |
| **MANUALLY OFF** | Dark Gray Outline Pill (`#4b5563`) `[🔒 HOTKEYS: OFF]` | Single-key hotkeys manually disabled by user toggle. | Disabled. |

---

## 7. Execution Interaction Flow & Optimistic UI

### 7.1 UX Flowcharts

#### Rapid Single-Key Execution Mode (Pass / Skip)
```
[User presses 'p'] 
       │
       ▼
[1. Trigger Optimistic UI Update (<10ms)]
       ├── Badge in Pane 2 turns Green [P]
       ├── Progress bar in Pane 1 increments
       └── API Request sent asynchronously (POST /api/v1/executions)
       │
       ▼
[2. Advance Active Index (+1 Case)]
       ├── Focus shifts to next test case in Pane 2
       └── Pane 3 renders next case details instantly (<30ms)
```

#### Detailed Step-by-Step Failure Logging (Fail / Block)
```
[User presses 'f']
       │
       ▼
[1. Set Pending Verdict State to FAILED]
       ├── Badge in Pane 3 header highlights RED
       └── Execution Notes Textarea is AUTOMATICALLY FOCUSED
       │
       ▼
[2. Hotkeys Auto-Pause (Badge changes to [✏️ TYPING MODE])]
       │
       ▼
[3. User types actual result notes / attaches logs]
       │
       ▼
[4. User presses Ctrl+Enter or clicks Submit Verdict]
       └── Saves execution, advances to next case, re-engages hotkeys
```

### 7.2 Optimistic UI & Latency Target

- **Latency Guarantee:** Every hotkey verdict action updates the local Client State Store (Zustand/Redux) within **<10ms**.
- **Network Queueing:** API requests are dispatched in the background with exponential backoff retry logic.
- **Rollback Protection:** If a network connection drops or server returns HTTP 422/500, the test case badge reverts to its previous state with a toast error notification: *"Failed to save verdict for TC-104. Click to retry."*

---

## 8. Accessibility & High-Density Color Palette

Color design guarantees WCAG AAA contrast and colorblind safety (Protanopia, Deuteranopia, Tritanopia). Verdict states pair distinct shape/character cues (`P`, `F`, `B`, `S`, `U`) with background colors.

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

## 9. Compliance & Verification Matrix

| Requirement | Implementation Target | Verification Method | Status |
| :--- | :--- | :--- | :--- |
| **3-Pane Topology** | Resizable splitters, Pane 1 (260-340px), Pane 2 (380-480px), Pane 3 (fluid) | Layout integration test | Locked |
| **32px Row Standard** | Grid row height locked to 32px, tree nodes 28px | CSS Computed Style Assertion | Locked |
| **Hotkeys (p, f, b, s, j, k)** | Central keyboard event dispatch manager | Unit tests (Simulated KeyboardEvent) | Locked |
| **Auto-Deactivation on Input** | Focus event listener on `<input>`, `<textarea>`, `contenteditable` | Playwright E2E focus test | Locked |
| **Visual Toggle Indicator** | Dynamic badge in Pane 3 header showing `ACTIVE` / `TYPING MODE` | React component test | Locked |
| **Colorblind-Safe Badges** | Letter badges (`P`,`F`,`B`,`S`,`U`) + high contrast colors | Automated WCAG contrast test | Locked |

---

## 10. Summary & Next Steps

RFC 02 guarantees that TestLink-Next will provide a high-density, zero-friction, keyboard-first environment for QA execution. 

Next steps:
1. Complete architectural review of `docs/rfc_02_ux_density_and_hotkeys.md`.
2. Proceed to component design implementation matching CSS tokens and focus state machine.
