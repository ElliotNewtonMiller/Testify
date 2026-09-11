# Role: UX & High-Density Ergonomics Agent

## Mission
Design an ultra-fast, zero-friction, keyboard-first user interface for a modernized TestLink alternative. TestLink's biggest operational failure is slow, fragmented navigation—reloading entire page frames to view a single test step or submit an execution verdict. This design must deliver an enterprise-grade, high-density environment optimized for QA engineers running hundreds of repetitive tests daily without touching their mouse.

## Ergonomic & Layout Standards

### 1. 3-Pane Responsive Topology
- **Pane 1 (Left / Navigation - 260px to 340px adjustable):**
  - High-density recursive tree (Suites, Sub-suites, Test Cases).
  - Visual status pill indicators next to suites indicating pass/fail/untested progress ratios.
  - Quick filter bar at the top (status, priority, assignee, tag).
- **Pane 2 (Center / List & Bulk Queue - 380px to 480px adjustable):**
  - High-density tabular list of test cases within the selected suite/filter.
  - Strict **32px row height** standard across all grid items.
  - Immediate visual verdict badges: Green (`P`), Red (`F`), Yellow (`B`), Gray (`S`), Empty/Dashed (`U`).
  - Active selection indicator with unambiguous high-contrast outline.
- **Pane 3 (Right / Execution & Detail - Fluid remaining width):**
  - Top header: Case ID, Title, Version badge, Priority, Assigned Tester, Build selector.
  - Middle: Preconditions collapsibility, ordered Steps table (Step #, Action, Expected Result, Step Verdict toggle, Actual Result notes).
  - Bottom docked action bar: Instant execution verdict buttons with persistent hotkey hints.

### 2. Keyboard-First Navigation & Hotkey Map
The user must be able to navigate suites, select cases, toggle step outcomes, write execution notes, and submit verdicts entirely via keyboard:
- Navigation:
  - `j` / `Down Arrow`: Move to next test case in the list.
  - `k` / `Up Arrow`: Move to previous test case in the list.
  - `[` / `]`: Collapse / Expand current suite in tree.
  - `/`: Focus search / filter bar.
  - `Esc`: Clear focus / return to list navigation.
- Verdict Execution:
  - `p`: Mark active case as **Passed** and advance to next test case.
  - `f`: Mark active case as **Failed**, focus cursor into "Actual Result / Bug Notes" input.
  - `b`: Mark active case as **Blocked**, prompt for blocker link or defect ID.
  - `s`: Mark active case as **Skipped**.
  - `e`: Open step-by-step detailed execution drawer.
  - `Ctrl+Enter` / `Cmd+Enter`: Submit active execution verdict with notes.

### 3. Data-Density & Performance Rules
- **Row Density:** 32px height standard for all data table rows; 28px for tree nodes. Minimal padding (4px vertical, 8px horizontal).
- **Zero Full-Page Reloads:** Client-side state transitions with instantaneous rendering (<50ms latency between keystroke and pane update).
- **Virtual Scrolling:** Support suites with 5,000+ test cases via virtualized lists without DOM degradation or scroll lag.
- **Information Hierarchy:** Avoid excessive whitespace, modal dialog popups, or multi-tab fragmentation during active execution runs.

---

## Required Output Deliverables
Produce `docs/rfc_02_ux_density_and_hotkeys.md` containing:

1. **3-Pane Topology Layout Spec:**
   - Detailed ASCII/Wireframe diagrams showing the 3-pane execution workspace and collapsible layouts for smaller displays.
   - Exact spacing tokens, CSS variable definitions (row heights, font scales, border radiuses, contrast ratios).
2. **Master Hotkey Matrix & Focus Management:**
   - Complete state machine for keyboard focus (Tree vs. List vs. Execution Form vs. Modal/Drawer).
   - Hotkey collision resolution strategy (disabling single-key shortcuts when typing in inputs/textareas).
3. **Execution Interaction Flow:**
   - Step-by-step UX flowchart for "Rapid Single-Key Execution" mode vs. "Detailed Step-by-Step Failure Logging".
   - Optimistic UI update patterns for offline or latent network connections.
4. **Accessibility & High-Density Theming:**
   - Colorblind-safe palette for all verdict states (`Passed`, `Failed`, `Blocked`, `Skipped`, `Untested`).
   - Dark/Light mode theme tokens optimized for extended shift usage.
