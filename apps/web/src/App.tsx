import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useFocusFSM, FocusZone } from "./hooks/useFocusFSM";
import { useHotkeyEngine, VerdictType } from "./hooks/useHotkeyEngine";
import { buildExecutionCaseOrder, nextExecutionCaseIndex } from "./utils/executionCaseOrder";
import { FocusIndicatorBadge } from "./components/FocusIndicatorBadge";
import {
  TestCaseQueueGrid,
  TestCaseGridItem,
} from "./components/TestCaseQueueGrid";
import {
  VirtualizedSuiteTree,
  SuiteTreeNode,
} from "./components/VirtualizedSuiteTree";
import {
  SpecCaseListGrid,
  SpecCaseGridItem,
} from "./components/SpecCaseListGrid";
import { AuthModal, UserProfile } from "./components/AuthModal";
import { AdminPanelModal } from "./components/AdminPanelModal";
import { ImportWizardModal } from "./components/ImportWizardModal";
import { ExportModal } from "./components/ExportModal";
import { ReportingModal } from "./components/ReportingModal";
import { LoginPage } from "./components/LoginPage";
import { CustomFieldEditor } from "./components/CustomFieldEditor";
import {
  CaseFilterPanel,
  CaseFilterField,
  CaseFilterState,
  EMPTY_CASE_FILTER,
  isFieldAvailable,
  toApiFilters,
} from "./components/CaseFilterPanel";
import {
  EntityManagementModal,
  EntityItem,
  EntityType,
  ActionType,
} from "./components/EntityManagementModal";

interface Step {
  id: string;
  step_number: number;
  action: string;
  expected_result: string;
}

interface TestCase extends TestCaseGridItem {
  execution_type: string;
  version_number: number;
  summary: string;
  preconditions: string;
  steps: Step[];
  latest_execution_id: string | null;
  latest_notes?: string | null;
  test_suite_id?: string;
}

interface WorkspaceData {
  project: { id: string; name: string; prefix: string };
  suites: Array<{ id: string; name: string; path: string }>;
  plan: { id: string; name: string; status: string };
  build: { id: string; name: string; status: string };
  cases: TestCase[];
}

// --- Specification mode: types for GET /api/v1/projects/:id/spec-tree and
// GET /api/v1/test-cases/:id/latest-version. Curation-only -- read-only case/step detail,
// plus per-case/suite plan-inclusion toggles. See docs/rfc_01_domain_model.md §2.3.
interface SpecSuiteNode {
  id: string;
  name: string;
  path: string;
  parent_suite_id: string | null;
  children: SpecSuiteNode[];
  total_case_count: number;
  in_plan_count: number;
}

/** Keeps only suites whose id is in `keep` (the case-search response's suite_ids already
 * includes every ancestor of a match, so the result stays a connected tree). */
function pruneSuiteTree(nodes: SpecSuiteNode[], keep: Set<string>): SpecSuiteNode[] {
  return nodes
    .filter((n) => keep.has(n.id))
    .map((n) => ({ ...n, children: pruneSuiteTree(n.children, keep) }));
}

interface SpecTreeData {
  project: { id: string; name: string; prefix: string; settings: { allow_draft_plan_linking: boolean } };
  suites: SpecSuiteNode[];
  cases: SpecCaseGridItem[];
}

interface SpecCaseDetail {
  test_case: { id: string; external_id: string; title: string; priority: string; execution_type: string };
  version: {
    id: string;
    version_number: number;
    status: string;
    summary: string | null;
    preconditions: string | null;
    steps: Step[];
  };
}

export type CustomFieldType = "TEXT" | "NUMBER" | "CHECKBOX" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT";

export interface CustomFieldDefinition {
  id: string;
  entity_type: "TestCase" | "TestSuite";
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  is_required: boolean;
  default_value: string | null;
  validation_regex: string | null;
  options: Array<{ option_label: string; option_value: string }>;
}

export interface CustomFieldValueEntry {
  definition: CustomFieldDefinition;
  value: unknown;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Grows a textarea to fit its content instead of showing a scrollbar -- resetting height to
// "auto" first (rather than just reading scrollHeight directly) is required so the element
// can shrink back down too, not just grow: scrollHeight never reports smaller than the
// element's current height, so without the reset a field would never shrink after its
// content got shorter (e.g. deleting a wrapped line). Called from a mount-time ref callback
// (so a field that already has long content shows fully expanded immediately, not just after
// the first keystroke) and from onInput while typing.
function autoGrowTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

type StepsScrollRestoreMode = "restore" | "scrollToBottom";

/**
 * Shared scroll-preservation primitives for the Spec-mode step editor (see
 * specDetailScrollRef). Reordering/removing/adding a step mutates DOM nodes inside that
 * scroll container, and React's commit-phase focus/selection restoration (restoreSelection)
 * engages whenever a mutation touches a subtree containing the currently-focused node,
 * re-applying a snapshotted scroll offset that can land wrong -- captureScroll/
 * blurActiveElement/scheduleRestore give every mutation site the same, consistent discipline
 * (capture the position worth keeping -> blur so restoreSelection has nothing to misapply ->
 * mutate -> schedule the correction) instead of four independently hand-rolled variants, which
 * is exactly how one of the four (addStep) ended up missing the blur step in an earlier pass.
 * scheduleRestore's correction runs in a useLayoutEffect -- synchronously after the DOM
 * mutation/any restoreSelection adjustment but strictly before the browser paints -- so it's
 * always the last word before the user sees a frame, never a later, visibly-corrective jump.
 */
function useStepsScrollPreserved(
  scrollRef: React.RefObject<HTMLDivElement>,
  endAnchorRef?: React.RefObject<HTMLDivElement>,
) {
  const preservedTopRef = useRef<number | null>(null);
  const pendingModeRef = useRef<StepsScrollRestoreMode | null>(null);
  const [restoreTick, setRestoreTick] = useState(0);

  const captureScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) preservedTopRef.current = el.scrollTop;
  }, [scrollRef]);

  const blurActiveElement = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  // "restore" re-applies the position captureScroll last saw (right for a reorder/removal,
  // which shouldn't move the viewport at all); "scrollToBottom" ignores the captured value and
  // scrolls to the new bottom instead (right for an append, where the previous scrollTop would
  // now fall short of the true bottom by one row's height and leave the new row off-screen).
  const scheduleRestore = useCallback((mode: StepsScrollRestoreMode) => {
    pendingModeRef.current = mode;
    setRestoreTick((t) => t + 1);
  }, []);

  useLayoutEffect(() => {
    const mode = pendingModeRef.current;
    if (mode === null) return;
    pendingModeRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    if (mode === "scrollToBottom") {
      // Content (custom fields) now sits BELOW the step list, so the container's own bottom
      // is no longer the steps' bottom -- scroll just far enough to bring the end-of-steps
      // anchor into view (never upward), falling back to the true bottom without an anchor.
      const anchor = endAnchorRef?.current;
      if (anchor) {
        const delta = anchor.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
        if (delta > 0) el.scrollTop += delta;
      } else {
        el.scrollTop = el.scrollHeight;
      }
      // Keep the captured position in sync with where an append just scrolled to -- the
      // in-flight autosave triggered by the blur that preceded this add later schedules a
      // "restore", which would otherwise snap back to the pre-append scrollTop it captured.
      preservedTopRef.current = el.scrollTop;
    } else if (preservedTopRef.current !== null) {
      el.scrollTop = preservedTopRef.current;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTick]);

  return { captureScroll, blurActiveElement, scheduleRestore };
}

const DEFAULT_FALLBACK_WORKSPACE: WorkspaceData = {
  project: { id: "prj_01", name: "Testify Core", prefix: "TFY" },
  suites: [
    { id: "ste_01", name: "Authentication & Security", path: "/Security" },
    { id: "ste_02", name: "Execution Engine & Dual Driver", path: "/CoreLoop" },
    { id: "ste_03", name: "RBAC & Admin Management", path: "/Admin" },
  ],
  plan: { id: "pln_01", name: "v1.0 Acceptance Plan", status: "ACTIVE" },
  build: { id: "bld_01", name: "Build 2026.09.09-RC1", status: "OPEN" },
  cases: [
    {
      plan_case_id: "tpc_01",
      case_id: "cas_01",
      external_id: "TFY-101",
      title: "Verify initial superuser admin login & password policy",
      priority: "HIGH",
      execution_type: "MANUAL",
      version_number: 1,
      summary:
        "Validates admin / password initial credentials and password complexity rules.",
      preconditions: "System initialized with database seed.",
      steps: [
        {
          id: "stp_01",
          step_number: 1,
          action: "Navigate to Log In page",
          expected_result:
            "Log In form renders with username and password fields",
        },
        {
          id: "stp_02",
          step_number: 2,
          action: "Enter admin / password and click Log In",
          expected_result: "Authenticates user and opens 3-pane workspace",
        },
      ],
      latest_verdict: "PASSED",
      latest_execution_id: "exec_01",
    },
    {
      plan_case_id: "tpc_02",
      case_id: "cas_02",
      external_id: "TFY-102",
      title: "Verify explicit per-project role enforcement & RBAC Admin Panel",
      priority: "CRITICAL",
      execution_type: "AUTOMATED",
      version_number: 1,
      summary:
        "Validates 2-tier permission evaluation and admin user roster management.",
      preconditions:
        "User logged in with USER_MANAGE or SYSTEM_ADMIN privilege.",
      steps: [
        {
          id: "stp_03",
          step_number: 1,
          action: "Click Admin Panel button in header",
          expected_result:
            "3-tab Admin Panel opens showing User Roster, Matrix, and Security Audit Log",
        },
      ],
      latest_verdict: "UNTESTED",
      latest_execution_id: null,
    },
  ],
};

export default function App() {
  // Starts as the fallback placeholder, not null -- workspaceMode now defaults to
  // SPECIFICATION, whose own bootstrap effect never calls refreshExecutionWorkspace() (only
  // Execution mode does), so a null initial value would leave this permanently unset and the
  // "Loading..." gate below stuck forever for anyone who starts (or stays) in Spec mode. The
  // real Execution-mode data still loads normally the moment the user actually switches modes.
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(DEFAULT_FALLBACK_WORKSPACE);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [failureNotes, setFailureNotes] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("Connected");
  // Search & filter (Pane 1, under the Execute/Spec toggle). Evaluated only on the server
  // (POST .../case-search); filterResult holds the matching ids, or null when nothing is
  // active (show everything). Session-only, not persisted.
  const [caseFilter, setCaseFilter] = useState<CaseFilterState>(EMPTY_CASE_FILTER);
  const [caseFilterFields, setCaseFilterFields] = useState<CaseFilterField[]>([]);
  const [filterResult, setFilterResult] = useState<{ caseIds: Set<string>; suiteIds: Set<string> } | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  // Bumped after edits that can change whether a case matches but don't replace specData/
  // workspace (custom field value saves), so the active filter re-evaluates.
  const [filterDataTick, setFilterDataTick] = useState(0);
  const caseSearchRequestSeq = useRef(0);
  const caseFilterFieldsRequestSeq = useRef(0);
  const [showStepDrawer, setShowStepDrawer] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Resizable 3-pane layout widths (Pane 1: Suite Tree, Pane 2: Spec/Queue Grid). Not
  // persisted to localStorage -- resets to defaults every session/reload, per direct request.
  const [suiteTreeWidth, setSuiteTreeWidth] = useState<number>(280);
  const [queueGridWidth, setQueueGridWidth] = useState<number>(420);
  const [hoveredDivider, setHoveredDivider] = useState<"tree" | "queue" | null>(null);
  const [draggingPane, setDraggingPane] = useState<"tree" | "queue" | null>(null);

  const suiteTreeWidthRef = useRef(suiteTreeWidth);
  useEffect(() => {
    suiteTreeWidthRef.current = suiteTreeWidth;
  }, [suiteTreeWidth]);
  const queueGridWidthRef = useRef(queueGridWidth);
  useEffect(() => {
    queueGridWidthRef.current = queueGridWidth;
  }, [queueGridWidth]);

  const dragStateRef = useRef<{ pane: "tree" | "queue"; startX: number; startWidth: number } | null>(null);

  const SUITE_TREE_MIN = 200;
  const SUITE_TREE_MAX = 480;
  const QUEUE_GRID_MIN = 260;
  const QUEUE_GRID_MAX = 600;
  const PANE3_MIN_WIDTH = 360; // Pane 3 must always keep at least this much room

  // window-level listeners (added on mousedown, removed on mouseup) rather than an
  // onMouseMove handler on the divider itself -- a fast drag routinely outruns a 4px-wide
  // element, so only page-level tracking keeps up with the cursor for the whole drag.
  const handleDividerMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const deltaX = e.clientX - drag.startX;
    if (drag.pane === "tree") {
      const max = Math.max(
        SUITE_TREE_MIN,
        Math.min(SUITE_TREE_MAX, window.innerWidth - PANE3_MIN_WIDTH - queueGridWidthRef.current),
      );
      setSuiteTreeWidth(Math.min(Math.max(drag.startWidth + deltaX, SUITE_TREE_MIN), max));
    } else {
      const max = Math.max(
        QUEUE_GRID_MIN,
        Math.min(QUEUE_GRID_MAX, window.innerWidth - PANE3_MIN_WIDTH - suiteTreeWidthRef.current),
      );
      setQueueGridWidth(Math.min(Math.max(drag.startWidth + deltaX, QUEUE_GRID_MIN), max));
    }
  }, []);

  const handleDividerMouseUp = useCallback(() => {
    dragStateRef.current = null;
    setDraggingPane(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", handleDividerMouseMove);
    window.removeEventListener("mouseup", handleDividerMouseUp);
  }, [handleDividerMouseMove]);

  const handleDividerMouseDown = useCallback(
    (pane: "tree" | "queue") => (e: React.MouseEvent) => {
      e.preventDefault();
      dragStateRef.current = {
        pane,
        startX: e.clientX,
        startWidth: pane === "tree" ? suiteTreeWidthRef.current : queueGridWidthRef.current,
      };
      setDraggingPane(pane);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", handleDividerMouseMove);
      window.addEventListener("mouseup", handleDividerMouseUp);
    },
    [handleDividerMouseMove, handleDividerMouseUp],
  );

  // Unmount safety net -- removeEventListener on an unregistered listener is a harmless
  // no-op, so this is safe to run even when no drag is in progress.
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleDividerMouseMove);
      window.removeEventListener("mouseup", handleDividerMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleDividerMouseMove, handleDividerMouseUp]);

  const dividerStyle = (pane: "tree" | "queue"): React.CSSProperties => ({
    width: "4px",
    flexShrink: 0,
    cursor: "col-resize",
    backgroundColor: draggingPane === pane || hoveredDivider === pane ? "#3b82f6" : "#1f2937",
  });

  // Specification / Execution mode toggle (Pane 1 header) & Specification-mode state
  const [workspaceMode, setWorkspaceMode] = useState<"EXECUTION" | "SPECIFICATION">(
    "SPECIFICATION",
  );
  const [specData, setSpecData] = useState<SpecTreeData | null>(null);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  // Mirrors selectedSuiteId for reads from inside an already-in-flight async closure (see
  // handleSuiteCustomFieldValueChange) -- same race this file already guards against for
  // specSelectedCaseIdRef below, just for the suite-details custom fields instead.
  const selectedSuiteIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedSuiteIdRef.current = selectedSuiteId;
  }, [selectedSuiteId]);
  const [specSelectedCaseId, setSpecSelectedCaseId] = useState<string | null>(
    null,
  );
  // Mirrors specSelectedCaseId for reads from inside an already-in-flight async closure (see
  // handleCustomFieldValueChange) -- a blur-triggered custom-field autosave for a case the
  // user has since navigated away from must not let its late-arriving response patch the
  // now-different case's displayed values.
  const specSelectedCaseIdRef = useRef<string | null>(null);
  useEffect(() => {
    specSelectedCaseIdRef.current = specSelectedCaseId;
  }, [specSelectedCaseId]);
  const [specCaseDetail, setSpecCaseDetail] = useState<SpecCaseDetail | null>(
    null,
  );
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  const [specCaseCustomFieldValues, setSpecCaseCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  // Read-only custom field values for the case currently being executed (Execution mode).
  const [execCaseCustomFieldValues, setExecCaseCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  const [savingCustomFieldId, setSavingCustomFieldId] = useState<string | null>(null);
  const [customFieldErrorById, setCustomFieldErrorById] = useState<Record<string, string>>({});
  // Bumped per-definition when a save is rejected (e.g. a required field's value was cleared,
  // 422 REQUIRED_FIELD_MISSING) -- included in CustomFieldEditor's `key` below so a rejected
  // edit forces a remount back to the last known-good value (specCaseCustomFieldValues was
  // never updated on failure, so it's still correct) instead of leaving the uncontrolled
  // input showing whatever invalid text the user typed, which never actually got saved. Without
  // this, a required field that a user cleared and failed to save still LOOKS blank even
  // though the real stored value is untouched -- easy to mistake for "the app let me approve
  // with an empty required field" when actually the field was quietly still holding its last
  // real value the whole time.
  const [customFieldResetKeyById, setCustomFieldResetKeyById] = useState<Record<string, number>>({});
  // Suite-level custom field values for whichever suite is selected in Specification mode --
  // shown/edited in Pane 3's Suite Details view (see specActiveCase/selectedSuiteId below).
  // Same shape as specCaseCustomFieldValues above: clear-before-fetch discipline (the editors
  // are uncontrolled) and a savingId/errorById/resetKeyById set per field.
  const [suiteCustomFieldValues, setSuiteCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  const [savingSuiteCustomFieldId, setSavingSuiteCustomFieldId] = useState<string | null>(null);
  const [suiteCustomFieldErrorById, setSuiteCustomFieldErrorById] = useState<Record<string, string>>({});
  const [suiteCustomFieldResetKeyById, setSuiteCustomFieldResetKeyById] = useState<Record<string, number>>({});

  // Suite create/rename form (inline, not a modal).
  const [suiteFormState, setSuiteFormState] = useState<{
    mode: "CREATE" | "RENAME";
    targetId: string | null; // the suite being renamed (RENAME) or the parent to create under (CREATE, may be null for top-level)
    name: string;
    description: string;
    parentSuiteId: string | null;
  } | null>(null);
  const [isSavingSuiteForm, setIsSavingSuiteForm] = useState(false);

  // Two-step delete confirmation for suites -- mirrors AdminPanelModal's deleteFieldPrompt.
  const [deleteSuitePrompt, setDeleteSuitePrompt] = useState<{ id: string; detail: string } | null>(null);

  // Two-step delete confirmation for test plans, same shape as deleteSuitePrompt -- shown by
  // handleDeletePlanClick after a non-force delete comes back 409 (bypasses
  // EntityManagementModal entirely, so this is the only confirmation dialog ever shown).
  const [deletePlanPrompt, setDeletePlanPrompt] = useState<{ id: string; name: string; detail: string } | null>(null);
  // Same shape one level down, for test runs (builds) -- see handleDeleteRunClick.
  const [deleteRunPrompt, setDeleteRunPrompt] = useState<{ id: string; name: string; detail: string } | null>(null);
  // Shown in the same banner slot as deletePlanPrompt/deleteRunPrompt when the "+ Create New
  // Test Run" button is clicked with no plan selected -- a Run can never exist without one.
  const [noPlanSetWarning, setNoPlanSetWarning] = useState(false);

  // Case create form (inline in Pane 2's header) and two-step delete confirmation for cases.
  const [isCaseCreateFormOpen, setIsCaseCreateFormOpen] = useState(false);
  const [newCaseTitle, setNewCaseTitle] = useState("");
  const [newCasePriority, setNewCasePriority] = useState("MEDIUM");
  const [newCaseExecutionType, setNewCaseExecutionType] = useState("MANUAL");
  const [isCreatingCase, setIsCreatingCase] = useState(false);
  const [deleteCasePrompt, setDeleteCasePrompt] = useState<{ id: string; detail: string } | null>(null);

  // Inline title/priority/execution_type editing on the case detail header -- always
  // editable regardless of version status, since these live on test_cases directly.
  const [savingCaseFieldError, setSavingCaseFieldError] = useState<string | null>(null);

  // Draft-versioning: steps are edited as a local buffer while the latest version is
  // DRAFT, re-synced whenever the selected case or its version identity changes.
  const [stepsDraft, setStepsDraft] = useState<Step[]>([]);
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [isApprovingVersion, setIsApprovingVersion] = useState(false);
  const [isSavingSteps, setIsSavingSteps] = useState(false);
  const [specEditError, setSpecEditError] = useState<string | null>(null);

  // Authentication & RBAC User State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState<boolean>(false);
  const [importWizardOpen, setImportWizardOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [reportingModalOpen, setReportingModalOpen] = useState<boolean>(false);
  const [userPermissions, setUserPermissions] = useState<string[]>([]);

  // Entity Selection State (Project, Plan, Run)
  const [projectsList, setProjectsList] = useState<EntityItem[]>([
    { id: "prj_01", name: "Testify Core", prefix: "TFY" },
    { id: "prj_02", name: "Security Audit Engine", prefix: "SEC" },
    { id: "prj_03", name: "Automation Framework", prefix: "AUTO" },
  ]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("prj_01");

  const [plansList, setPlansList] = useState<EntityItem[]>([
    { id: "pln_01", name: "v1.0 Acceptance Plan", status: "ACTIVE" },
    { id: "pln_02", name: "Regression Suite 2026", status: "ACTIVE" },
    { id: "pln_03", name: "Draft Feature Specs", status: "DRAFT" },
  ]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("pln_01");

  // No fake seed data here (unlike the historical prj_01/pln_01 placeholders elsewhere,
  // which get overwritten quickly by the real bootstrap fetch) -- a Run can never exist
  // without a real Test Plan (builds.test_plan_id is NOT NULL), so starting empty and
  // relying on refreshExecutionWorkspace's real per-plan fetch (or the clearing effect
  // below, when there's no plan at all) means the dropdown never shows a run that isn't
  // genuinely tied to the currently selected plan.
  const [runsList, setRunsList] = useState<EntityItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");

  // Entity Modal State
  const [entityModalOpen, setEntityModalOpen] = useState<boolean>(false);
  const [modalEntityType, setModalEntityType] = useState<EntityType>("PROJECT");
  const [modalActionType, setModalActionType] = useState<ActionType>("CREATE");
  const [modalSelectedItem, setModalSelectedItem] = useState<EntityItem | null>(
    null,
  );

  const notesInputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Per-row refs for the step editor's Action textareas, keyed by index -- lets addStep()
  // focus the newly-added row's Action field once it exists in the DOM (see the
  // pendingStepFocusIndexRef effect below addStep).
  const stepActionRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const pendingStepFocusIndexRef = useRef<number | null>(null);
  // Tracks the in-flight steps-save request (if any) -- see saveSteps' own comment for the
  // stale-save race this guards against between a field's blur-triggered save and a
  // Move/Remove's own save.
  const stepsSaveAbortRef = useRef<AbortController | null>(null);
  // The Spec-mode case detail pane's own scroll container (Summary/Preconditions/steps all
  // live inside it) -- see useStepsScrollPreserved above for why this needs tracking at all.
  const specDetailScrollRef = useRef<HTMLDivElement>(null);
  const stepsEndAnchorRef = useRef<HTMLDivElement>(null);
  const stepsScroll = useStepsScrollPreserved(specDetailScrollRef, stepsEndAnchorRef);

  // Which verdict the notes textarea is currently "for" -- set whenever Fail/Block is
  // triggered (hotkey or button) so a later Ctrl+Enter/blur submit uses that verdict
  // instead of always assuming FAILED.
  const pendingVerdictRef = useRef<VerdictType>("FAILED");
  // Whether the textarea has unsubmitted user edits. A plain ref (not state) so the
  // Ctrl+Enter path can mark it false synchronously before its own .blur() call fires the
  // textarea's onBlur handler, avoiding a duplicate submission from that same keypress.
  const notesDirtyRef = useRef(false);

  // Guard against out-of-order fetch responses: selectedProjectId/selectedPlanId go through
  // a fake-seed -> real-id bootstrap sequence (see loadProjects/loadPlans), which can fire
  // several requests in quick succession. Without this, a slower, now-stale response (e.g.
  // for the fake seed id) can resolve after a newer one and silently overwrite fresh data.
  const specTreeRequestSeq = useRef(0);
  // Shared by BOTH refreshExecutionWorkspace and refreshRunsList -- they're two different
  // ways of populating the same runsList/selectedRunId state (the heavier one, used in
  // Execution mode, gets builds "for free" alongside the case queue it also fetches; the
  // lighter one, used in Specification mode, fetches just the builds), and a stale in-flight
  // call from EITHER one must be able to invalidate the other's write, not just its own --
  // e.g. switching Spec (plan A) -> Execute (still A) -> a different plan B while still in
  // Execute mode must not let plan A's now-abandoned Spec-mode fetch resolve later and
  // silently overwrite plan B's freshly-loaded runs. One seq per logical resource being
  // protected (runsList/selectedRunId), not one per function, matches how plansRequestSeq/
  // specTreeRequestSeq are already scoped to the state they guard.
  const runsListRequestSeq = useRef(0);
  const plansRequestSeq = useRef(0);

  // Display Toast Notification (moved above the entity/spec handlers below, which reference it)
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  }, []);

  // ---- Search & filter ----
  // Field catalog for the "+ Filter" property picker. Re-fetched on project change and
  // whenever "+ Filter" is clicked (picks up custom fields added since). Rows naming a field
  // that no longer exists (deleted, or a different project) are dropped once a catalog for
  // the current project actually arrives -- never on a failed fetch.
  const loadCaseFilterFields = useCallback(async () => {
    const seq = ++caseFilterFieldsRequestSeq.current;
    if (!selectedProjectId) return;
    try {
      const res = await fetch(`/api/v1/projects/${selectedProjectId}/case-search/fields`, { headers: authHeaders() });
      if (seq !== caseFilterFieldsRequestSeq.current || !res.ok) return;
      const data = await res.json();
      if (seq !== caseFilterFieldsRequestSeq.current) return;
      const fields: CaseFilterField[] = data.fields || [];
      setCaseFilterFields(fields);
      const keys = new Set(fields.map((f) => f.key));
      setCaseFilter((prev) => {
        const kept = prev.filters.filter((r) => r.field === "" || keys.has(r.field));
        return kept.length === prev.filters.length ? prev : { ...prev, filters: kept };
      });
    } catch {
      // Leave the previous catalog in place; the panel still works with what it has.
    }
  }, [selectedProjectId]);

  useEffect(() => {
    loadCaseFilterFields();
  }, [loadCaseFilterFields]);

  const caseFilterFieldsByKey = new Map(caseFilterFields.map((f) => [f.key, f]));
  const filterContext = {
    mode: workspaceMode,
    hasPlan: Boolean(selectedPlanId),
    hasRun: Boolean(selectedRunId),
  };
  const apiCaseFilters = toApiFilters(caseFilter.filters, caseFilterFieldsByKey, (f) =>
    isFieldAvailable(f, filterContext),
  );
  const trimmedCaseQuery = caseFilter.q.trim();
  const isCaseFilterActive = trimmedCaseQuery !== "" || apiCaseFilters.length > 0;
  // Stable string key so the effect below only re-runs when the effective request changes,
  // not on every keystroke that doesn't change it (e.g. trailing spaces, an empty new row).
  const caseFilterRequestKey = JSON.stringify({ q: trimmedCaseQuery, filters: apiCaseFilters });

  useEffect(() => {
    // Bumped unconditionally (before any early return) so clearing the filter or switching
    // context also invalidates any request still in flight -- same discipline as
    // runsListRequestSeq.
    const seq = ++caseSearchRequestSeq.current;
    if (!isCaseFilterActive || !selectedProjectId) {
      setFilterResult(null);
      setFilterError(null);
      return;
    }
    const { q, filters } = JSON.parse(caseFilterRequestKey) as {
      q: string;
      filters: Array<{ field: string; op: string; value?: unknown }>;
    };
    // Only send plan/build when a filter needs them, so a plan/run switch that's still
    // settling can't 404 an unrelated search.
    const needsPlan = filters.some((f) => f.field === "in_plan");
    const needsBuild = filters.some((f) => f.field === "verdict");
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/case-search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            q,
            filters,
            ...(needsPlan && selectedPlanId ? { plan_id: selectedPlanId } : {}),
            ...(needsBuild && selectedRunId ? { build_id: selectedRunId } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (seq !== caseSearchRequestSeq.current) return;
        if (!res.ok) {
          setFilterError(
            Array.isArray(data.details) ? data.details.join("; ") : data.error || "Search failed",
          );
          return;
        }
        setFilterError(null);
        setFilterResult({
          caseIds: new Set<string>(data.case_ids || []),
          suiteIds: new Set<string>(data.suite_ids || []),
        });
      } catch {
        if (seq === caseSearchRequestSeq.current) setFilterError("Search failed: network error");
      }
    }, 250);
    return () => clearTimeout(handle);
    // specData/workspace identity + filterDataTick: re-evaluate after data changes (a
    // verdict recorded, a case edited, a custom field value saved) so matches stay current.
  }, [
    caseFilterRequestKey,
    isCaseFilterActive,
    selectedProjectId,
    selectedPlanId,
    selectedRunId,
    workspaceMode,
    specData,
    workspace,
    filterDataTick,
  ]);

  // Shared 401 handling for the Spec-mode save handlers below (create/approve/edit-content/
  // save-steps). Login tokens are still finite-lived (1 hour JWTs, no refresh mechanism -- see
  // packages/core/src/security/jwt.ts), and unlike verdict submission (a single fast POST),
  // Spec-mode editing is often a long, network-idle drafting session (typing into steps,
  // reordering, etc. is pure client-side state with zero requests) before the user finally
  // clicks Save/Approve -- so that click is often the first request issued after the token
  // has silently expired. Without this, the handler's generic catch surfaces the raw
  // "Unauthorized: Token expired" server string and leaves the dead token in localStorage,
  // so every retry just fails the same way. Mirrors submitVerdict's existing 401 branch
  // (clear the token, drop back to a logged-out state, toast a clear message) so every
  // Spec-mode save handler behaves the same way execution recording already does.
  const handleAuthExpiry = useCallback(() => {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("user_id");
    setCurrentUser(null);
    setUserPermissions([]);
    showToast("Session expired -- please log in again");
  }, [showToast]);

  const openEntityModal = (entityType: EntityType, actionType: ActionType) => {
    let targetItem: EntityItem | null = null;
    if (entityType === "PROJECT") {
      targetItem =
        projectsList.find((p) => p.id === selectedProjectId) ||
        projectsList[0] ||
        null;
    } else if (entityType === "PLAN") {
      targetItem =
        plansList.find((p) => p.id === selectedPlanId) || plansList[0] || null;
    } else if (entityType === "RUN") {
      targetItem =
        runsList.find((r) => r.id === selectedRunId) || runsList[0] || null;
    }

    setModalEntityType(entityType);
    setModalActionType(actionType);
    setModalSelectedItem(targetItem);
    setEntityModalOpen(true);
  };

  const handleSaveEntity = (
    entityType: EntityType,
    actionType: ActionType,
    item: EntityItem,
  ) => {
    if (entityType === "PROJECT") {
      if (actionType === "CREATE") {
        setProjectsList((prev) => [...prev, item]);
        setSelectedProjectId(item.id);
        setWorkspace((prev) =>
          prev
            ? {
                ...prev,
                project: {
                  id: item.id,
                  name: item.name,
                  prefix: item.prefix || "TFY",
                },
              }
            : prev,
        );
        showToast(`Created New Project: ${item.name}`);
      } else if (actionType === "EDIT") {
        setProjectsList((prev) =>
          prev.map((p) => (p.id === item.id ? item : p)),
        );
        setWorkspace((prev) =>
          prev && prev.project.id === item.id
            ? {
                ...prev,
                project: {
                  ...prev.project,
                  name: item.name,
                  prefix: item.prefix || prev.project.prefix,
                },
              }
            : prev,
        );
        showToast(`Updated Project: ${item.name}`);
      } else if (actionType === "DELETE") {
        const updated = projectsList.filter((p) => p.id !== item.id);
        setProjectsList(updated);
        if (selectedProjectId === item.id && updated.length > 0) {
          setSelectedProjectId(updated[0].id);
          setWorkspace((prev) =>
            prev
              ? {
                  ...prev,
                  project: {
                    id: updated[0].id,
                    name: updated[0].name,
                    prefix: updated[0].prefix || "TFY",
                  },
                }
              : prev,
          );
        }
        showToast(`Deleted Project: ${item.name}`);
      }
    } else if (entityType === "PLAN") {
      // Real backend calls -- see apps/server/src/routes/projects.ts's POST/PUT/DELETE
      // .../plans routes. Unlike PROJECT/RUN below (still client-side mock state, a known,
      // separately-flagged gap), Test Plan create/edit/delete now actually persists.
      // DELETE is handled by handleDeletePlanClick below instead of here -- it bypasses this
      // modal entirely (see that function's comment for why).
      if (!selectedProjectId) return;
      if (actionType === "CREATE") {
        (async () => {
          try {
            const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders() },
              body: JSON.stringify({ name: item.name, status: item.status || "ACTIVE" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to create test plan");
            const created = data.plan;
            setPlansList((prev) => [...prev, { id: created.id, name: created.name, status: created.status }]);
            setSelectedPlanId(created.id);
            setWorkspace((prev) =>
              prev ? { ...prev, plan: { id: created.id, name: created.name, status: created.status } } : prev,
            );
            showToast(`Created New Test Plan: ${created.name}`);
          } catch (err: any) {
            showToast(err.message || "Failed to create test plan");
          }
        })();
      } else if (actionType === "EDIT") {
        (async () => {
          try {
            const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans/${item.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...authHeaders() },
              body: JSON.stringify({ name: item.name, status: item.status }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to update test plan");
            const updatedPlan = data.plan;
            setPlansList((prev) =>
              prev.map((p) => (p.id === updatedPlan.id ? { id: updatedPlan.id, name: updatedPlan.name, status: updatedPlan.status } : p)),
            );
            setWorkspace((prev) =>
              prev && prev.plan.id === updatedPlan.id
                ? { ...prev, plan: { ...prev.plan, name: updatedPlan.name, status: updatedPlan.status } }
                : prev,
            );
            showToast(`Updated Test Plan: ${updatedPlan.name}`);
          } catch (err: any) {
            showToast(err.message || "Failed to update test plan");
          }
        })();
      }
    } else if (entityType === "RUN") {
      // Real backend calls -- see apps/server/src/routes/projects.ts's POST/PUT
      // .../plans/:planId/builds routes. A run always belongs to whichever plan is currently
      // selected (there's no plan-picker in the modal -- matches how creating a Suite
      // implicitly uses the selected project, not a picker). DELETE is handled by
      // handleDeleteRunClick below instead of here, same reasoning as Plan delete above.
      if (!selectedProjectId || !selectedPlanId) return;
      if (actionType === "CREATE") {
        (async () => {
          try {
            const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans/${selectedPlanId}/builds`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders() },
              body: JSON.stringify({ name: item.name, status: item.status || "OPEN" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to create test run");
            const created = data.build;
            setRunsList((prev) => [...prev, { id: created.id, name: created.name, status: created.status }]);
            setSelectedRunId(created.id);
            setWorkspace((prev) =>
              prev ? { ...prev, build: { id: created.id, name: created.name, status: created.status } } : prev,
            );
            showToast(`Created New Test Run: ${created.name}`);
          } catch (err: any) {
            showToast(err.message || "Failed to create test run");
          }
        })();
      } else if (actionType === "EDIT") {
        (async () => {
          try {
            const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans/${selectedPlanId}/builds/${item.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...authHeaders() },
              body: JSON.stringify({ name: item.name, status: item.status }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to update test run");
            const updatedRun = data.build;
            setRunsList((prev) =>
              prev.map((r) => (r.id === updatedRun.id ? { id: updatedRun.id, name: updatedRun.name, status: updatedRun.status } : r)),
            );
            setWorkspace((prev) =>
              prev && prev.build.id === updatedRun.id
                ? { ...prev, build: { ...prev.build, name: updatedRun.name, status: updatedRun.status } }
                : prev,
            );
            showToast(`Updated Test Run: ${updatedRun.name}`);
          } catch (err: any) {
            showToast(err.message || "Failed to update test run");
          }
        })();
      }
    }
  };

  // Shared local-state update after a plan is genuinely gone server-side (either path: a
  // clean non-force delete, or the confirmed force delete below). Computed from the current
  // plansList directly (not via setPlansList's functional-updater form) so the remaining-list
  // length is available to decide selectedPlanId's next value without nesting one setState
  // call inside another's updater callback.
  const applyPlanDeletedLocally = (deletedId: string) => {
    const updated = plansList.filter((p) => p.id !== deletedId);
    setPlansList(updated);
    if (selectedPlanId === deletedId) {
      if (updated.length > 0) {
        setSelectedPlanId(updated[0].id);
        setWorkspace((prev) =>
          prev ? { ...prev, plan: { id: updated[0].id, name: updated[0].name, status: updated[0].status || "ACTIVE" } } : prev,
        );
      } else {
        // The last plan for this project is gone -- clear selectedPlanId (rather than
        // leaving it dangling on the deleted id) so refreshSpecTree's selectedPlanId-keyed
        // effect re-fires and refetches without a plan_id, immediately showing every case
        // as not-in-plan instead of stale "In Plan" badges from the deleted plan.
        setSelectedPlanId("");
        // The deleted plan's builds are genuinely gone too (deleteWithForce cascades them
        // server-side) -- without this, runsList/selectedRunId are never touched again, since
        // refreshExecutionWorkspace itself no-ops once selectedPlanId is empty, leaving a
        // stale, now-nonexistent Run showing in the dropdown forever.
        setRunsList([]);
        setSelectedRunId("");
      }
    }
  };

  // Plan delete (two-step confirmation), matching handleDeleteSuiteClick's exact pattern --
  // attempts the real delete immediately with no separate "are you sure?" dialog first. That
  // used to be EntityManagementModal's job (open a generic confirm modal, then on Confirm
  // Click, this same attempt would run and could STILL come back 409 and show a second,
  // content-bearing warning banner below it -- two stacked dialogs for one delete). Bypassing
  // the modal for PLAN/DELETE specifically means the blocked-with-counts banner (below) is
  // the only confirmation shown, ever -- same one-dialog shape Suite/Case delete already has.
  const handleDeletePlanClick = useCallback(
    async (planId: string) => {
      if (!selectedProjectId) return;
      const planName = plansList.find((p) => p.id === planId)?.name || "";
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans/${planId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (res.status === 409) {
          const data = await res.json();
          setDeletePlanPrompt({ id: planId, name: planName, detail: data.detail || "This test plan still contains content." });
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}) as any);
          throw new Error(data.error || "Failed to delete test plan");
        }
        applyPlanDeletedLocally(planId);
        showToast(`Deleted Test Plan: ${planName}`);
      } catch (err: any) {
        showToast(err.message || "Failed to delete test plan");
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [selectedProjectId, plansList, showToast],
  );

  const handleConfirmDeletePlan = useCallback(async () => {
    if (!deletePlanPrompt || !selectedProjectId) return;
    try {
      const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans/${deletePlanPrompt.id}?force=true`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as any);
        throw new Error(data.error || "Failed to delete test plan");
      }
      applyPlanDeletedLocally(deletePlanPrompt.id);
      const deletedName = deletePlanPrompt.name;
      setDeletePlanPrompt(null);
      showToast(`Deleted Test Plan: ${deletedName}`);
    } catch (err: any) {
      showToast(err.message || "Failed to delete test plan");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deletePlanPrompt, selectedProjectId, plansList, selectedPlanId, showToast]);

  // Same shape as applyPlanDeletedLocally/handleDeletePlanClick/handleConfirmDeletePlan above,
  // one level down (a run belongs to the selected plan, not the project).
  const applyRunDeletedLocally = (deletedId: string) => {
    const updated = runsList.filter((r) => r.id !== deletedId);
    setRunsList(updated);
    if (selectedRunId === deletedId) {
      if (updated.length > 0) {
        setSelectedRunId(updated[0].id);
        setWorkspace((prev) =>
          prev ? { ...prev, build: { id: updated[0].id, name: updated[0].name, status: updated[0].status || "OPEN" } } : prev,
        );
      } else {
        setSelectedRunId("");
      }
    }
  };

  const handleDeleteRunClick = useCallback(
    async (runId: string) => {
      if (!selectedProjectId || !selectedPlanId) return;
      const runName = runsList.find((r) => r.id === runId)?.name || "";
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans/${selectedPlanId}/builds/${runId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (res.status === 409) {
          const data = await res.json();
          setDeleteRunPrompt({ id: runId, name: runName, detail: data.detail || "This test run still contains content." });
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}) as any);
          throw new Error(data.error || "Failed to delete test run");
        }
        applyRunDeletedLocally(runId);
        showToast(`Deleted Test Run: ${runName}`);
      } catch (err: any) {
        showToast(err.message || "Failed to delete test run");
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [selectedProjectId, selectedPlanId, runsList, showToast],
  );

  const handleConfirmDeleteRun = useCallback(async () => {
    if (!deleteRunPrompt || !selectedProjectId || !selectedPlanId) return;
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/plans/${selectedPlanId}/builds/${deleteRunPrompt.id}?force=true`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as any);
        throw new Error(data.error || "Failed to delete test run");
      }
      applyRunDeletedLocally(deleteRunPrompt.id);
      const deletedName = deleteRunPrompt.name;
      setDeleteRunPrompt(null);
      showToast(`Deleted Test Run: ${deletedName}`);
    } catch (err: any) {
      showToast(err.message || "Failed to delete test run");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteRunPrompt, selectedProjectId, selectedPlanId, runsList, selectedRunId, showToast]);

  const handleSelectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setSelectedSuiteId(null);
    setSpecSelectedCaseId(null);
    const target = projectsList.find((p) => p.id === projectId);
    if (target) showToast(`Switched to Project: ${target.name}`);
  };

  const handleSelectPlan = (planId: string) => {
    setSelectedPlanId(planId);
    const target = plansList.find((p) => p.id === planId);
    if (target) showToast(`Switched to Test Plan: ${target.name}`);
  };

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    const target = runsList.find((r) => r.id === runId);
    if (target) showToast(`Switched to Test Run: ${target.name}`);
  };

  // Real project/plan listings (replaces the hardcoded fake dropdown data that used to live
  // here -- prj_01/02/03, pln_01/02/03 -- none of which exist in the DB).
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/projects", { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data.projects && data.projects.length > 0) {
          const mapped: EntityItem[] = data.projects.map((p: any) => ({
            id: p.id,
            name: p.name,
            prefix: p.prefix,
          }));
          setProjectsList(mapped);
          setSelectedProjectId((prev) =>
            mapped.some((p) => p.id === prev) ? prev : mapped[0].id,
          );
        }
      }
    } catch {
      // Network error -- keep the existing (fallback) list
    }
  }, []);

  const loadPlans = useCallback(async (projectId: string) => {
    // selectedProjectId itself goes through the same fake-seed -> real-id bootstrap sequence
    // documented above (specTreeRequestSeq), so this effect can fire loadPlans twice in quick
    // succession (once for the fake seed id, once for the real one) with no guarantee the
    // fake id's fetch resolves first -- without a sequence guard, a slower-resolving stale
    // call (even one that legitimately 404s/succeeds for its own now-abandoned project id)
    // can overwrite the real project's freshly-loaded plansList with stale or empty data.
    const seq = ++plansRequestSeq.current;
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/plans`, {
        headers: authHeaders(),
      });
      if (plansRequestSeq.current !== seq) return;
      if (res.ok) {
        const data = await res.json();
        if (plansRequestSeq.current !== seq) return;
        const mapped: EntityItem[] = (data.plans || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          status: p.status,
        }));
        setPlansList(mapped);
        // A project can genuinely have zero plans (e.g. its last one was just deleted) --
        // without this branch, selectedPlanId/plansList were left stale on whatever the
        // previous project had, so Spec mode kept showing a since-gone plan's "In Plan"
        // state indefinitely.
        setSelectedPlanId((prev) =>
          mapped.length === 0 ? "" : mapped.some((p) => p.id === prev) ? prev : mapped[0].id,
        );
      } else {
        // A non-ok response (e.g. a stale/fake project id from PROJECT's still-mock CREATE
        // path -- see the "Notable gaps" entry in CLAUDE.md) previously left plansList/
        // selectedPlanId (and via those, runsList/selectedRunId) untouched, so switching to
        // a project whose plans-fetch fails kept showing the PREVIOUS project's plan/run --
        // a live-reproduced instance of "test runs existing independently of test plans".
        // Clearing here is more correct than showing data that isn't this project's.
        setPlansList([]);
        setSelectedPlanId("");
      }
    } catch {
      if (plansRequestSeq.current !== seq) return;
      setPlansList([]);
      setSelectedPlanId("");
    }
  }, []);

  // Execution-mode workspace: parameterized by the selected plan (and optionally build)
  // instead of hardcoded to the seed plan/build like the old /api/v1/workspace endpoint.
  const refreshExecutionWorkspace = useCallback(async () => {
    // Bump the sequence guard BEFORE the early-return, not after -- the effect below fires
    // on selectedProjectId changing even when selectedPlanId hasn't caught up yet (loadPlans
    // clears it asynchronously), so a project switch can call this once with the *previous*
    // project's still-current selectedPlanId (a real, valid plan id, so its fetch succeeds)
    // and then again after selectedPlanId clears to "". If the early-return below didn't bump
    // the sequence, the first call's in-flight fetch could resolve after the second call has
    // already (correctly) cleared runsList, silently repopulating it with the old project's
    // run -- exactly the "switching to a project with no plans leaves a stale Run selected"
    // bug this guards against.
    const seq = ++runsListRequestSeq.current;
    if (!selectedPlanId) {
      if (runsListRequestSeq.current === seq) {
        setWorkspace(DEFAULT_FALLBACK_WORKSPACE);
        setRunsList([]);
        setSelectedRunId("");
      }
      return;
    }
    try {
      const url = selectedRunId
        ? `/api/v1/test-plans/${selectedPlanId}/cases?build_id=${encodeURIComponent(selectedRunId)}`
        : `/api/v1/test-plans/${selectedPlanId}/cases`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (runsListRequestSeq.current !== seq) return; // a newer request already resolved
        const projectEntity = projectsList.find((p) => p.id === selectedProjectId);
        const builds = data.builds || [];

        setWorkspace({
          project: projectEntity
            ? {
                id: projectEntity.id,
                name: projectEntity.name,
                prefix: projectEntity.prefix || "TFY",
              }
            : DEFAULT_FALLBACK_WORKSPACE.project,
          suites: [],
          plan: { id: data.plan.id, name: data.plan.name, status: data.plan.status },
          build: builds[0]
            ? { id: builds[0].id, name: builds[0].name, status: builds[0].status }
            : DEFAULT_FALLBACK_WORKSPACE.build,
          cases: data.cases.map((c: any) => ({
            plan_case_id: c.plan_case_id,
            case_id: c.case_id,
            test_suite_id: c.test_suite_id,
            external_id: c.external_id,
            title: c.title,
            priority: c.priority,
            execution_type: c.execution_type,
            version_number: c.version_number,
            summary: c.summary,
            preconditions: c.preconditions,
            steps: c.steps,
            latest_verdict: c.latest_verdict || "UNTESTED",
            latest_execution_id: c.latest_execution_id || null,
            latest_notes: c.latest_notes || null,
          })),
        });

        // Always update runsList/selectedRunId, even when builds is empty -- a plan that
        // genuinely has zero runs must clear the dropdown, not leave the *previous* plan's
        // runs showing (the old `if (builds.length > 0)` guard here skipped both setters
        // entirely on an empty result, which is the same staleness bug already fixed for
        // loadPlans/the selectedPlanId-empty case, just triggered here by switching to a
        // *real* plan that has no runs rather than having no plan at all).
        const runItems: EntityItem[] = builds.map((b: any) => ({
          id: b.id,
          name: (b.name || "").replace(/^Build\s+/i, "Run "),
          status: b.status,
        }));
        setRunsList(runItems);
        setSelectedRunId((prev) =>
          runItems.length === 0 ? "" : runItems.some((r) => r.id === prev) ? prev : runItems[0].id,
        );
        return;
      }
    } catch {
      // API offline fallback
    }
    if (runsListRequestSeq.current === seq) {
      setWorkspace(DEFAULT_FALLBACK_WORKSPACE);
      // Same staleness concern as above -- a failed fetch shouldn't leave a previous plan's
      // runs showing under the (now unconfirmed) currently-selected plan.
      setRunsList([]);
      setSelectedRunId("");
    }
  }, [selectedPlanId, selectedProjectId, selectedRunId, projectsList]);

  // Specification mode's lighter counterpart to refreshExecutionWorkspace above -- Spec mode
  // has no use for the full case/step queue that endpoint also fetches (its own suite/case
  // data comes from refreshSpecTree instead), but the Run dropdown is part of the always-
  // rendered shared header, not gated by mode, so it still needs runsList/selectedRunId kept
  // correct while in Spec mode. Without this, switching Project/Plan while in Spec mode left
  // the Run dropdown frozen on whatever it last showed in Execution mode -- refreshExecutionWorkspace
  // was the ONLY code path that ever refreshed it, and the shared effect below only calls that
  // one in Execution mode. Hits the same lightweight GET .../plans/:planId/builds route
  // ExportModal already uses for its own Build picker (apps/server/src/routes/exports.ts) --
  // returns the exact same Build shape refreshExecutionWorkspace already maps into runItems,
  // just without the expensive case/step join. Shares runsListRequestSeq with
  // refreshExecutionWorkspace (see that ref's own comment) rather than using its own counter,
  // so a stale in-flight call from either function can never win over a newer one from either.
  const refreshRunsList = useCallback(async () => {
    // Bump before the early-return, for the exact same reason refreshExecutionWorkspace does
    // (see its own comment) -- a project/plan switch can call this once with a still-current
    // but about-to-be-abandoned selectedPlanId before it clears asynchronously.
    const seq = ++runsListRequestSeq.current;
    if (!selectedPlanId) {
      if (runsListRequestSeq.current === seq) {
        setRunsList([]);
        setSelectedRunId("");
      }
      return;
    }
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/plans/${selectedPlanId}/builds`,
        { headers: authHeaders() },
      );
      if (res.ok) {
        const data = await res.json();
        if (runsListRequestSeq.current !== seq) return; // a newer request already resolved
        const builds = data.builds || [];
        // Same shape/behavior as refreshExecutionWorkspace's own runItems mapping -- an empty
        // builds array must still positively clear the list, not leave stale data showing.
        const runItems: EntityItem[] = builds.map((b: any) => ({
          id: b.id,
          name: (b.name || "").replace(/^Build\s+/i, "Run "),
          status: b.status,
        }));
        setRunsList(runItems);
        setSelectedRunId((prev) =>
          runItems.length === 0 ? "" : runItems.some((r) => r.id === prev) ? prev : runItems[0].id,
        );
        return;
      }
    } catch {
      // API offline fallback
    }
    if (runsListRequestSeq.current === seq) {
      setRunsList([]);
      setSelectedRunId("");
    }
  }, [selectedPlanId, selectedProjectId]);

  // Specification-mode data: the whole project's suite/case spec, annotated with the
  // selected plan's inclusion state. Also drives Pane 1's suite tree in BOTH modes (see
  // suiteNodes below), fixing the tree's pre-existing flat/fake-count display.
  const refreshSpecTree = useCallback(async () => {
    // plan_id is genuinely optional on this route (apps/server/src/routes/testPlanCases.ts) --
    // omitted, every case just comes back in_plan: false rather than 404ing. That's what makes
    // it safe to still fetch (and show real suites/cases, correctly annotated as not-in-plan)
    // when the project currently has no test plan at all, instead of leaving whatever was
    // fetched for a since-deleted plan stale on screen.
    if (!selectedProjectId) return;
    const seq = ++specTreeRequestSeq.current;
    try {
      const url = selectedPlanId
        ? `/api/v1/projects/${selectedProjectId}/spec-tree?plan_id=${selectedPlanId}`
        : `/api/v1/projects/${selectedProjectId}/spec-tree`;
      const res = await fetch(url, { headers: authHeaders() });
      const data = res.ok ? await res.json() : null;
      if (specTreeRequestSeq.current === seq) setSpecData(data);
    } catch {
      if (specTreeRequestSeq.current === seq) setSpecData(null);
    }
  }, [selectedProjectId, selectedPlanId]);

  // Per-case/suite plan-inclusion toggles (Specification mode). Both call the new
  // apps/server/src/routes/testPlanCases.ts endpoints, then refresh the spec tree so
  // in_plan/tri-state counts reflect the change.
  const handleToggleCaseInclusion = useCallback(
    async (testCaseId: string, include: boolean) => {
      if (!selectedPlanId) {
        showToast("No test plan selected");
        return;
      }
      setPendingToggleId(testCaseId);
      try {
        const res = await fetch(
          include
            ? `/api/v1/test-plans/${selectedPlanId}/cases`
            : `/api/v1/test-plans/${selectedPlanId}/cases/${testCaseId}`,
          {
            method: include ? "POST" : "DELETE",
            // Content-Type: application/json on a bodyless DELETE trips Fastify's JSON body
            // parser (it 400s on an empty body when that header is present) -- only set it
            // when there's actually a JSON body to send.
            headers: include
              ? { "Content-Type": "application/json", ...authHeaders() }
              : { ...authHeaders() },
            body: include ? JSON.stringify({ test_case_id: testCaseId }) : undefined,
          },
        );
        if (res.ok) {
          showToast(include ? "Added to plan" : "Removed from plan");
          await refreshSpecTree();
        } else {
          const body = await res.json().catch(() => ({}) as any);
          showToast(`🔒 ${body.detail || body.error || "Could not update plan membership"}`);
        }
      } catch {
        showToast("Network error updating plan membership");
      } finally {
        setPendingToggleId(null);
      }
    },
    [selectedPlanId, showToast, refreshSpecTree],
  );

  const handleToggleSuiteInclusion = useCallback(
    async (suiteId: string, action: "ADD" | "REMOVE") => {
      if (!selectedPlanId) {
        showToast("No test plan selected");
        return;
      }
      setPendingToggleId(suiteId);
      try {
        const res = await fetch(
          `/api/v1/test-plans/${selectedPlanId}/suites/${suiteId}/cascade`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ action }),
          },
        );
        if (res.ok) {
          const body = await res.json();
          const parts: string[] = [];
          if (body.added) parts.push(`${body.added} added`);
          if (body.removed) parts.push(`${body.removed} removed`);
          if (body.skipped?.length) parts.push(`${body.skipped.length} skipped`);
          showToast(parts.length > 0 ? parts.join(", ") : "No changes");
          await refreshSpecTree();
        } else {
          const body = await res.json().catch(() => ({}) as any);
          showToast(`🔒 ${body.detail || body.error || "Could not update plan membership"}`);
        }
      } catch {
        showToast("Network error updating plan membership");
      } finally {
        setPendingToggleId(null);
      }
    },
    [selectedPlanId, showToast, refreshSpecTree],
  );

  const activeCase = workspace?.cases[selectedIndex] || null;
  const isCompleted =
    activeCase?.latest_verdict && activeCase.latest_verdict !== "UNTESTED";

  // Keyboard Focus FSM
  const fsm = useFocusFSM({
    initialZone: "EXECUTION_CONTAINER",
    permissions: userPermissions,
    isExecutionCompleted: Boolean(isCompleted),
  });

  // Fetch current user profile (/api/v1/auth/me). No client-side fallback session: if the
  // server doesn't confirm the token, the user is logged out. (This used to fabricate a fake
  // Admin session in the UI when a magic localStorage value was present or the request failed --
  // that never granted real API access once the server started requiring signed tokens, but it
  // could show a misleading "logged in as admin" state. Removed 2026-09-11.)
  const fetchCurrentUser = useCallback(async () => {
    try {
      const storedToken = localStorage.getItem("auth_token");
      if (!storedToken) {
        setCurrentUser(null);
        return;
      }

      const res = await fetch("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${storedToken}` },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          setCurrentUser(data.user);
          setUserPermissions(data.user.permissions || []);
        } else {
          setCurrentUser(null);
        }
      } else {
        // Token missing/expired/invalid per the server -- clear it so we don't keep retrying
        // with a dead token, and show the login screen.
        localStorage.removeItem("auth_token");
        localStorage.removeItem("user_id");
        setCurrentUser(null);
      }
    } catch {
      // Network error reaching the server -- treat as logged out rather than assuming a session.
      setCurrentUser(null);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  // Logout handler
  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Ignore network error on logout
    }
    localStorage.removeItem("auth_token");
    localStorage.removeItem("user_id");
    setCurrentUser(null);
    setUserPermissions([]);
    showToast("Signed out successfully.");
  }, [showToast]);

  useEffect(() => {
    fetchCurrentUser();
  }, [fetchCurrentUser]);

  // Real project list only resolves once authenticated (the endpoint requires a Bearer
  // token) -- (re)load it whenever a session is established, whether from a restored
  // token on mount or a fresh login.
  useEffect(() => {
    if (currentUser) {
      loadProjects();
    }
  }, [currentUser, loadProjects]);

  // Real plan list for whichever project is currently selected.
  useEffect(() => {
    if (currentUser && selectedProjectId) {
      loadPlans(selectedProjectId);
    }
  }, [currentUser, selectedProjectId, loadPlans]);

  // The actual workspace data fetch: Specification mode always needs the spec tree (it also
  // drives Pane 1's suite tree in BOTH modes -- see suiteNodes below). The Run dropdown's
  // data is a three-way split: Execution mode needs the full execution queue (which carries
  // the plan's builds "for free" alongside it), Specification mode has no use for that queue
  // but still needs the Run dropdown itself kept correct (it's part of the shared header, not
  // mode-gated), so it gets the lighter builds-only fetch instead -- see refreshRunsList's own
  // comment for why this split exists.
  useEffect(() => {
    // refreshSpecTree itself now tolerates no plan being selected (see its own comment);
    // refreshExecutionWorkspace/refreshRunsList both self-guard on selectedPlanId, so it's
    // safe to always attempt all of these here and let each decide what it can actually do.
    if (!currentUser || !selectedProjectId) return;
    refreshSpecTree();
    if (workspaceMode === "EXECUTION") {
      refreshExecutionWorkspace();
    } else {
      refreshRunsList();
    }
  }, [
    currentUser,
    workspaceMode,
    selectedProjectId,
    selectedPlanId,
    refreshSpecTree,
    refreshExecutionWorkspace,
    refreshRunsList,
  ]);

  // A Run can never exist without a real Test Plan (builds.test_plan_id is NOT NULL), so
  // runsList/selectedRunId must never show anything once there's no plan selected -- e.g.
  // switching to a project with zero plans, not just the plan-delete path (which already
  // clears these explicitly in applyPlanDeletedLocally). This reactive effect is the single
  // catch-all for every such path, current and future, rather than relying on each caller to
  // remember to clear it.
  useEffect(() => {
    if (!selectedPlanId) {
      setRunsList([]);
      setSelectedRunId("");
    }
  }, [selectedPlanId]);

  // Lazy per-case detail (steps/preconditions) for whichever case is selected in
  // Specification mode -- kept out of the bulk spec-tree payload to stay light for large
  // projects.
  useEffect(() => {
    if (workspaceMode !== "SPECIFICATION" || !specSelectedCaseId) {
      setSpecCaseDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-cases/${specSelectedCaseId}/latest-version`, {
          headers: authHeaders(),
        });
        if (!cancelled) setSpecCaseDetail(res.ok ? await res.json() : null);
      } catch {
        if (!cancelled) setSpecCaseDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, specSelectedCaseId]);

  // Re-syncs the local steps-edit buffer whenever the selected case's latest version
  // changes identity (a new case selected, a new draft created, or an approve just
  // happened) -- only meaningful while that version is DRAFT; otherwise cleared.
  useEffect(() => {
    if (specCaseDetail?.version?.status === "DRAFT") {
      setStepsDraft(specCaseDetail.version.steps.map((s) => ({ ...s })));
    } else {
      setStepsDraft([]);
    }
    setSpecEditError(null);
  }, [specCaseDetail?.version?.id, specCaseDetail?.version?.status]);

  // Global admin-defined custom field values for whichever case is selected in
  // Specification mode -- fetched alongside specCaseDetail above, same lazy-per-case pattern.
  useEffect(() => {
    // customFieldErrorById is keyed only by definitionId, not by (case, definitionId) -- the
    // same field definition is shared across every case, so an error left over from a
    // rejected edit on the PREVIOUS case would otherwise still show here, against a field
    // that (on this case) was never touched at all. Clear it on every case switch so an
    // error message only ever reflects this case's own most recent save attempt.
    setCustomFieldErrorById({});
    if (workspaceMode !== "SPECIFICATION" || !specSelectedCaseId) {
      setSpecCaseCustomFieldValues(null);
      return;
    }
    // Clear synchronously before fetching the new case's values -- the editors below are
    // uncontrolled (defaultValue-driven, see CustomFieldEditor.tsx), so if they were to stay
    // mounted showing the PREVIOUS case's still-current values while this fetch is in flight,
    // a later prop update once the fetch resolves would silently fail to update the already-
    // mounted DOM input's displayed value. Clearing first means there's nothing to show (or
    // stale) until the fresh data actually arrives.
    setSpecCaseCustomFieldValues(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-cases/${specSelectedCaseId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setSpecCaseCustomFieldValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setSpecCaseCustomFieldValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, specSelectedCaseId]);

  // Custom field values for whichever case is active in Execution mode -- shown read-only
  // under the steps. Same clear-before-fetch discipline as the Spec-mode fetch above (the
  // editors are uncontrolled, so nothing stale may be mounted while the fetch is in flight).
  const activeExecCaseId = activeCase?.case_id ?? null;
  useEffect(() => {
    if (workspaceMode !== "EXECUTION" || !activeExecCaseId) {
      setExecCaseCustomFieldValues(null);
      return;
    }
    setExecCaseCustomFieldValues(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-cases/${activeExecCaseId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setExecCaseCustomFieldValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setExecCaseCustomFieldValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, activeExecCaseId]);

  // Commits one custom field value edit via PUT, then optimistically patches local state
  // so the field reflects the save without waiting on a full spec-tree/detail refetch.
  const handleCustomFieldValueChange = useCallback(
    async (definitionId: string, value: unknown) => {
      if (!specSelectedCaseId) return;
      const requestCaseId = specSelectedCaseId;
      setSavingCustomFieldId(definitionId);
      setCustomFieldErrorById((prev) => {
        const next = { ...prev };
        delete next[definitionId];
        return next;
      });
      try {
        const res = await fetch(
          `/api/v1/test-cases/${requestCaseId}/custom-field-values/${definitionId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ value }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || data.error || "Failed to save custom field value");
        }
        setFilterDataTick((t) => t + 1);
        // The save genuinely succeeded against requestCaseId's own data regardless -- but if
        // the user has since navigated to a different case (e.g. a blur-triggered autosave
        // whose response arrives after the switch), specCaseCustomFieldValues now holds the
        // NEW case's values, and patching it here would silently overwrite that case's real
        // value with this now-irrelevant response. Skip the display update in that case.
        if (specSelectedCaseIdRef.current === requestCaseId) {
          setSpecCaseCustomFieldValues((prev) =>
            prev
              ? prev.map((entry) =>
                  entry.definition.id === definitionId ? { ...entry, value: data.value } : entry,
                )
              : prev,
          );
        }
      } catch (err: any) {
        setCustomFieldErrorById((prev) => ({
          ...prev,
          [definitionId]: err.message || "Failed to save",
        }));
        // Force the (uncontrolled) input back to the last known-good value -- see
        // customFieldResetKeyById's own comment for why this matters.
        setCustomFieldResetKeyById((prev) => ({ ...prev, [definitionId]: (prev[definitionId] ?? 0) + 1 }));
      } finally {
        setSavingCustomFieldId(null);
      }
    },
    [specSelectedCaseId],
  );

  // Global admin-defined custom field values for whichever suite is selected in
  // Specification mode -- backs Pane 3's Suite Details view. Same lazy-per-entity,
  // clear-before-fetch pattern as specCaseCustomFieldValues above.
  useEffect(() => {
    // Same fix as customFieldErrorById above -- keyed only by definitionId, so it must be
    // cleared on every suite switch or a rejected edit's error would keep showing against a
    // different suite's otherwise-untouched field.
    setSuiteCustomFieldErrorById({});
    if (workspaceMode !== "SPECIFICATION" || !selectedSuiteId) {
      setSuiteCustomFieldValues(null);
      return;
    }
    setSuiteCustomFieldValues(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-suites/${selectedSuiteId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setSuiteCustomFieldValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setSuiteCustomFieldValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, selectedSuiteId]);

  // Commits one suite custom field value edit via PUT -- mirrors handleCustomFieldValueChange
  // above exactly, including the same stale-response race guard (selectedSuiteIdRef).
  const handleSuiteCustomFieldValueChange = useCallback(
    async (definitionId: string, value: unknown) => {
      if (!selectedSuiteId) return;
      const requestSuiteId = selectedSuiteId;
      setSavingSuiteCustomFieldId(definitionId);
      setSuiteCustomFieldErrorById((prev) => {
        const next = { ...prev };
        delete next[definitionId];
        return next;
      });
      try {
        const res = await fetch(
          `/api/v1/test-suites/${requestSuiteId}/custom-field-values/${definitionId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ value }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || data.error || "Failed to save custom field value");
        }
        setFilterDataTick((t) => t + 1);
        if (selectedSuiteIdRef.current === requestSuiteId) {
          setSuiteCustomFieldValues((prev) =>
            prev
              ? prev.map((entry) =>
                  entry.definition.id === definitionId ? { ...entry, value: data.value } : entry,
                )
              : prev,
          );
        }
      } catch (err: any) {
        setSuiteCustomFieldErrorById((prev) => ({
          ...prev,
          [definitionId]: err.message || "Failed to save",
        }));
        setSuiteCustomFieldResetKeyById((prev) => ({ ...prev, [definitionId]: (prev[definitionId] ?? 0) + 1 }));
      } finally {
        setSavingSuiteCustomFieldId(null);
      }
    },
    [selectedSuiteId],
  );

  // ---- Suite/case create/edit/delete (Specification mode) ----

  const handleUpdateCaseField = useCallback(
    async (field: "title" | "priority" | "execution_type", value: string) => {
      if (!specSelectedCaseId || !selectedProjectId) return;
      setSavingCaseFieldError(null);
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-cases/${specSelectedCaseId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ [field]: value }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(data.error || data.detail || "Failed to save");
        }
        await refreshSpecTree();
      } catch (err: any) {
        setSavingCaseFieldError(err.message || "Failed to save");
      }
    },
    [specSelectedCaseId, selectedProjectId, refreshSpecTree, handleAuthExpiry],
  );

  const handleCreateDraft = useCallback(async () => {
    if (!specSelectedCaseId || !selectedProjectId) return;
    setIsCreatingDraft(true);
    setSpecEditError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-cases/${specSelectedCaseId}/versions/draft`,
        { method: "POST", headers: authHeaders() },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(data.error || data.detail || "Failed to create draft");
      }
      setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      await refreshSpecTree();
    } catch (err: any) {
      setSpecEditError(err.message || "Failed to create draft");
    } finally {
      setIsCreatingDraft(false);
    }
  }, [specSelectedCaseId, selectedProjectId, refreshSpecTree, handleAuthExpiry]);

  const handleApproveVersion = useCallback(async () => {
    if (!selectedProjectId || !specCaseDetail?.version) return;
    setIsApprovingVersion(true);
    setSpecEditError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}/approve`,
        { method: "POST", headers: authHeaders() },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(data.error || data.detail || "Failed to approve");
      }
      setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      await refreshSpecTree();
    } catch (err: any) {
      setSpecEditError(err.message || "Failed to approve");
    } finally {
      setIsApprovingVersion(false);
    }
  }, [selectedProjectId, specCaseDetail, refreshSpecTree, handleAuthExpiry]);

  const handleSaveVersionContent = useCallback(
    async (field: "summary" | "preconditions", value: string) => {
      if (!selectedProjectId || !specCaseDetail?.version) return;
      setSpecEditError(null);
      try {
        const res = await fetch(
          `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ [field]: value || null }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(data.error || data.detail || "Failed to save");
        }
        setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      } catch (err: any) {
        setSpecEditError(err.message || "Failed to save");
      }
    },
    [selectedProjectId, specCaseDetail, handleAuthExpiry],
  );

  // Steps autosave -- no explicit "Save Steps" button (per Elliot's request, matching the
  // Summary/Preconditions fields' existing silent-onBlur-save convention). Accepts an
  // optional explicit array so a structural change (remove/reorder) can save the freshly
  // computed array immediately rather than racing setStepsDraft's async state update --
  // stepsDraft itself is only safe to read from a blur handler, which fires after React
  // has already re-rendered with the latest onChange-driven state.
  const saveSteps = useCallback(
    async (stepsOverride?: Step[]) => {
      if (!selectedProjectId || !specCaseDetail?.version) return;
      const stepsToSave = stepsOverride ?? stepsDraft;
      // Abort any still-in-flight save before starting this one. Without this, a field's own
      // blur-triggered save (using stepsDraft as it was *before* a reorder/removal, since a
      // field's native blur fires before the Move/Remove button's own onClick even runs) can
      // still be in flight when moveStep/removeStep immediately fire their own save with the
      // freshly mutated array. With no cancellation, both requests hit the same PUT endpoint
      // and whichever happens to resolve last silently wins -- occasionally reverting the
      // user's reorder/removal back to the stale pre-mutation order. Aborting the previous
      // request here means only the most recently-started save can ever complete/apply.
      stepsSaveAbortRef.current?.abort();
      const controller = new AbortController();
      stepsSaveAbortRef.current = controller;
      setIsSavingSteps(true);
      setSpecEditError(null);
      try {
        const res = await fetch(
          `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({
              steps: stepsToSave.map((s, i) => ({
                step_number: i + 1,
                action: s.action,
                expected_result: s.expected_result,
              })),
            }),
            signal: controller.signal,
          },
        );
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(data.error || data.detail || "Failed to save steps");
        }
        setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      } catch (err: any) {
        // A superseded save is expected/intentional, not a real failure -- don't surface it.
        if (err?.name === "AbortError") return;
        setSpecEditError(err.message || "Failed to save steps");
      } finally {
        // Only the still-current (non-superseded) call gets to clear the saving indicator --
        // an aborted stale call's finally would otherwise fire almost immediately (abort
        // rejects fast) and flip isSavingSteps back to false while the real, newer save is
        // still genuinely in flight.
        if (stepsSaveAbortRef.current === controller) {
          setIsSavingSteps(false);
        }
        // This setSpecCaseDetail/setIsSavingSteps commit is the second of the two scroll-
        // resetting commits described in useStepsScrollPreserved's comment -- schedule a
        // restore again here, not just at the call site, since that first restore alone gets
        // silently overwritten once this async save actually resolves.
        stepsScroll.scheduleRestore("restore");
      }
    },
    [selectedProjectId, specCaseDetail, stepsDraft, handleAuthExpiry, stepsScroll],
  );

  // moveStep/removeStep compute the next array from the current stepsDraft directly (rather
  // than via setStepsDraft's functional-updater form) specifically so that same array can
  // also be handed to saveSteps() as a plain, synchronous side effect outside of state
  // reconciliation -- a fetch triggered from inside a state updater callback would be an
  // impure side effect there (risky under React StrictMode's intentional double-invocation
  // of updaters) and updater functions don't have anywhere to hand `next` back out anyway.
  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stepsDraft.length) return;
    stepsScroll.captureScroll();
    // The native click already focused this Move up/down button before this handler even
    // started (mousedown focuses synchronously, ahead of the click event). That focused
    // button's row is one of the two about to swap position -- blurring it here, before the
    // state update, means React's own commit-phase focus/selection preservation logic has
    // nothing focused left to "restore" a scroll position for, which is what was causing the
    // incorrect reset in the first place (see useStepsScrollPreserved's comment).
    stepsScroll.blurActiveElement();
    const next = [...stepsDraft];
    [next[index], next[target]] = [next[target], next[index]];
    setStepsDraft(next);
    stepsScroll.scheduleRestore("restore");
    saveSteps(next);
  };
  const updateStepField = (index: number, patch: Partial<Step>) => {
    setStepsDraft((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  const removeStep = (index: number) => {
    stepsScroll.captureScroll();
    stepsScroll.blurActiveElement();
    const next = stepsDraft.filter((_, i) => i !== index);
    setStepsDraft(next);
    stepsScroll.scheduleRestore("restore");
    saveSteps(next);
  };
  const addStep = () => {
    // Blur whatever's currently focused (typically the "+Add Step" button itself, which
    // Chromium native-focuses on click before this handler runs -- Safari/Firefox-mac don't,
    // so this is a partial mitigation, not the full fix; see the useLayoutEffect below for
    // why the fix works regardless of browser) before mutating state, matching moveStep/
    // removeStep's existing pattern: React's commit-phase focus/selection restoration
    // (restoreSelection) engages whenever a mutation touches a subtree containing the
    // currently-focused node -- inserting the new row right before a still-focused button
    // qualifies -- and re-applies a snapshotted scroll offset that can land wrong. Blurring
    // first gives it nothing to "restore" for.
    stepsScroll.blurActiveElement();
    setStepsDraft((prev) => {
      pendingStepFocusIndexRef.current = prev.length;
      return [
        ...prev,
        { id: `new-${Date.now()}`, step_number: prev.length + 1, action: "", expected_result: "" },
      ];
    });
    // Unlike moveStep/removeStep (which restore the pane's *previous* scroll position -- see
    // useStepsScrollPreserved's comment), a new step is appended at the end of the list, so
    // "stay at the bottom" means scrolling further down to the new bottom.
    stepsScroll.scheduleRestore("scrollToBottom");
  };

  // Focuses the newly-added row's Action field once it actually exists in the DOM (the ref
  // doesn't exist yet during addStep() itself). Scroll placement itself is handled by
  // useStepsScrollPreserved's own layout effect (scheduled via scrollToBottom above, which
  // React batches into the same commit as the setStepsDraft call here) -- this effect only
  // owns focusing the specific new field, which the shared hook has no way to know about.
  // useLayoutEffect (not useEffect) deliberately, for the same reason: focusing before paint
  // means preventScroll's suppression of the browser's own native scroll-into-view pass is
  // never raced by an intermediate painted frame.
  useLayoutEffect(() => {
    if (pendingStepFocusIndexRef.current !== null) {
      const idx = pendingStepFocusIndexRef.current;
      pendingStepFocusIndexRef.current = null;
      // preventScroll: true stops the browser's own native "scroll focused element into
      // view" pass from running at all -- useStepsScrollPreserved's own scrollTop assignment
      // is the only thing that gets to move scroll.
      stepActionRefs.current[idx]?.focus({ preventScroll: true });
    }
  }, [stepsDraft.length]);

  // Suite create/rename form
  const openCreateSuiteForm = (parentSuiteId: string | null) => {
    setSuiteFormState({ mode: "CREATE", targetId: parentSuiteId, name: "", description: "", parentSuiteId });
  };
  const openRenameSuiteForm = (suiteId: string, currentName: string, currentParentId: string | null) => {
    setSuiteFormState({ mode: "RENAME", targetId: suiteId, name: currentName, description: "", parentSuiteId: currentParentId });
  };
  const handleSaveSuiteForm = useCallback(async () => {
    if (!suiteFormState || !selectedProjectId) return;
    setIsSavingSuiteForm(true);
    try {
      const isCreate = suiteFormState.mode === "CREATE";
      const url = isCreate
        ? `/api/v1/projects/${selectedProjectId}/test-suites`
        : `/api/v1/projects/${selectedProjectId}/test-suites/${suiteFormState.targetId}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: suiteFormState.name,
          description: suiteFormState.description || null,
          parent_suite_id: isCreate ? suiteFormState.parentSuiteId : suiteFormState.parentSuiteId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "Failed to save suite");
      setSuiteFormState(null);
      showToast(isCreate ? "Suite created" : "Suite updated");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to save suite");
    } finally {
      setIsSavingSuiteForm(false);
    }
  }, [suiteFormState, selectedProjectId, refreshSpecTree, showToast]);

  // Renames a suite directly from Pane 3's Suite Details view -- a lighter always-editable
  // input (onBlur-save, matching the case title editor's pattern) rather than routing through
  // the fuller rename+move form above (still reachable via the tree's own rename icon, which
  // also lets you change the parent suite -- this one only ever touches the name).
  const handleUpdateSuiteName = useCallback(
    async (suiteId: string, name: string) => {
      if (!selectedProjectId) return;
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-suites/${suiteId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(data.error || data.detail || "Failed to rename suite");
        }
        await refreshSpecTree();
      } catch (err: any) {
        showToast(err.message || "Failed to rename suite");
      }
    },
    [selectedProjectId, refreshSpecTree, showToast, handleAuthExpiry],
  );

  // Suite delete (two-step confirmation)
  const handleDeleteSuiteClick = useCallback(
    async (suiteId: string) => {
      if (!selectedProjectId) return;
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-suites/${suiteId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (res.status === 409) {
          const data = await res.json();
          setDeleteSuitePrompt({ id: suiteId, detail: data.detail || "This suite still contains content." });
          return;
        }
        if (!res.ok && res.status !== 204) {
          const data = await res.json();
          throw new Error(data.error || "Failed to delete suite");
        }
        if (selectedSuiteId === suiteId) setSelectedSuiteId(null);
        showToast("Suite deleted");
        await refreshSpecTree();
      } catch (err: any) {
        showToast(err.message || "Failed to delete suite");
      }
    },
    [selectedProjectId, selectedSuiteId, refreshSpecTree, showToast],
  );
  const handleConfirmDeleteSuite = useCallback(async () => {
    if (!deleteSuitePrompt || !selectedProjectId) return;
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-suites/${deleteSuitePrompt.id}?force=true`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete suite");
      }
      if (selectedSuiteId === deleteSuitePrompt.id) setSelectedSuiteId(null);
      setDeleteSuitePrompt(null);
      showToast("Suite and its contents deleted");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to delete suite");
    }
  }, [deleteSuitePrompt, selectedProjectId, selectedSuiteId, refreshSpecTree, showToast]);

  // Case create
  const handleCreateCase = useCallback(async () => {
    if (!selectedProjectId || !selectedSuiteId || !newCaseTitle.trim()) return;
    setIsCreatingCase(true);
    try {
      const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          test_suite_id: selectedSuiteId,
          title: newCaseTitle,
          priority: newCasePriority,
          execution_type: newCaseExecutionType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "Failed to create case");
      setNewCaseTitle("");
      setIsCaseCreateFormOpen(false);
      await refreshSpecTree();
      setSpecSelectedCaseId(data.test_case.id);
      showToast("Case created");
    } catch (err: any) {
      showToast(err.message || "Failed to create case");
    } finally {
      setIsCreatingCase(false);
    }
  }, [selectedProjectId, selectedSuiteId, newCaseTitle, newCasePriority, newCaseExecutionType, refreshSpecTree, showToast]);

  // Case delete (two-step confirmation)
  const handleDeleteCaseClick = useCallback(
    async (caseId: string) => {
      if (!selectedProjectId) return;
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-cases/${caseId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (res.status === 409) {
          const data = await res.json();
          setDeleteCasePrompt({ id: caseId, detail: data.detail || "This case has recorded plan links or executions." });
          return;
        }
        if (!res.ok && res.status !== 204) {
          const data = await res.json();
          throw new Error(data.error || "Failed to delete case");
        }
        if (specSelectedCaseId === caseId) setSpecSelectedCaseId(null);
        showToast("Case deleted");
        await refreshSpecTree();
      } catch (err: any) {
        showToast(err.message || "Failed to delete case");
      }
    },
    [selectedProjectId, specSelectedCaseId, refreshSpecTree, showToast],
  );
  const handleConfirmDeleteCase = useCallback(async () => {
    if (!deleteCasePrompt || !selectedProjectId) return;
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-cases/${deleteCasePrompt.id}?force=true`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete case");
      }
      if (specSelectedCaseId === deleteCasePrompt.id) setSpecSelectedCaseId(null);
      setDeleteCasePrompt(null);
      showToast("Case and its history deleted");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to delete case");
    }
  }, [deleteCasePrompt, selectedProjectId, specSelectedCaseId, refreshSpecTree, showToast]);

  // Execute verdict submission (Optimistic UI + Background API)
  const submitVerdict = useCallback(
    async (
      verdict: VerdictType,
      notes?: string,
      targetCaseOverride?: TestCase,
    ) => {
      const targetCase = targetCaseOverride || activeCase;
      if (!targetCase || !workspace) return;

      // Whatever's in the Notes field gets saved regardless of verdict -- it's a general
      // "execution details or notes" field (see its placeholder), not failure-only, so a
      // note typed before hitting Pass/Skip shouldn't be silently discarded just because the
      // verdict isn't FAILED/BLOCKED.
      const resolvedNotes = notes || (failureNotes.trim() ? failureNotes : null);

      // 1. OPTIMISTIC UI UPDATE (<10ms) -- also updates latest_notes, not just
      // latest_verdict, so returning to this case (without a full refetch) shows the note
      // that was just submitted instead of whatever was cached from before.
      setWorkspace((prev) => {
        if (!prev) return prev;
        const updatedCases = prev.cases.map((c) =>
          c.plan_case_id === targetCase.plan_case_id
            ? { ...c, latest_verdict: verdict, latest_notes: resolvedNotes }
            : c,
        );
        return { ...prev, cases: updatedCases };
      });

      setSyncStatus(`Syncing verdict for ${targetCase.external_id}...`);

      // 2. DISPATCH BACKGROUND API CALL
      try {
        const storedToken = localStorage.getItem("auth_token");
        const response = await fetch("/api/v1/executions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
          },
          body: JSON.stringify({
            build_id: workspace.build.id,
            test_plan_case_id: targetCase.plan_case_id,
            verdict,
            status: "COMPLETED",
            notes: resolvedNotes,
            execution_duration_ms: Math.floor(Math.random() * 800) + 200,
          }),
        });

        if (response.ok) {
          setSyncStatus(
            `Connected (Recorded ${targetCase.external_id} -> ${verdict})`,
          );
        } else if (response.status === 401) {
          // Session expired or token invalid -- the server now requires a real, current
          // JWT for this route (EXECUTE_RUN permission). Clear the dead token and drop back
          // to the login screen rather than silently failing every subsequent keystroke.
          localStorage.removeItem("auth_token");
          localStorage.removeItem("user_id");
          setCurrentUser(null);
          setUserPermissions([]);
          setSyncStatus("Session expired -- please log in again");
        } else if (response.status === 403) {
          setSyncStatus("Not permitted: your role can't record executions");
        } else {
          setSyncStatus("API Error recording verdict");
        }
      } catch (err) {
        setSyncStatus("Network Error");
      }
    },
    [activeCase, workspace, failureNotes],
  );

  // Cases visible in Pane 2 for Specification mode: the whole project, or just the
  // currently selected suite's direct cases if one is selected in the tree.
  const specCasesForSuite: SpecCaseGridItem[] = specData
    ? specData.cases.filter(
        (c) =>
          (!selectedSuiteId || c.test_suite_id === selectedSuiteId) &&
          (!filterResult || filterResult.caseIds.has(c.id)),
      )
    : [];

  // Execution mode: indices into workspace.cases that pass the active search/filter (all of
  // them when none is active). selectedIndex always stays an index into workspace.cases --
  // the queue grid and hotkeys work in "visible position" space and map back through this,
  // so a filtered list can never select the wrong case. The active case may itself be
  // hidden by a filter (selection is left alone while typing); then no row is highlighted.
  const visibleCaseIndices: number[] = (workspace?.cases || []).reduce<number[]>((acc, c, i) => {
    if (!filterResult || filterResult.caseIds.has((c as any).case_id ?? "")) acc.push(i);
    return acc;
  }, []);
  const visibleCaseIndexSet = new Set(visibleCaseIndices);
  const selectedVisiblePos = visibleCaseIndices.indexOf(selectedIndex);
  // Next visible case after the active one in queue order (used by the Pass/Skip buttons),
  // or undefined if it's the last visible one.
  const nextVisibleCaseIndex = visibleCaseIndices.find((i) => i > selectedIndex);

  // Global Hotkey Engine Hook wiring. j/k/[/]//  stay valid in both modes; p/f/b/s
  // (verdict recording) are disabled in Specification mode -- see useHotkeyEngine's
  // `mode` option.
  useHotkeyEngine({
    fsm,
    mode: workspaceMode,
    caseCount:
      workspaceMode === "SPECIFICATION"
        ? specCasesForSuite.length
        : visibleCaseIndices.length,
    selectedIndex:
      workspaceMode === "SPECIFICATION"
        ? specCasesForSuite.findIndex((c) => c.id === specSelectedCaseId)
        : selectedVisiblePos,
    onSelectIndex: (idx) => {
      if (workspaceMode === "SPECIFICATION") {
        const target = specCasesForSuite[idx];
        if (target) setSpecSelectedCaseId(target.id);
      } else {
        const target = visibleCaseIndices[idx];
        if (target !== undefined) setSelectedIndex(target);
      }
    },
    onVerdict: (verdict) => {
      submitVerdict(verdict);
      // Always track the verdict just recorded, not just FAILED/BLOCKED -- a subsequent
      // note-only Ctrl+Enter (e.g. pressing 's' via hotkey, which doesn't auto-advance,
      // then typing a note) must resubmit with that same verdict, not a stale/default one.
      // Only FAILED/BLOCKED additionally auto-focus notes -- Pass/Skip stay quick actions.
      pendingVerdictRef.current = verdict;
      if (verdict === "FAILED" || verdict === "BLOCKED") {
        setTimeout(() => {
          if (notesInputRef.current) notesInputRef.current.focus();
        }, 50);
      }
    },
    onSubmitNotes: (notesText) => {
      // Submit with whatever verdict (FAILED or BLOCKED) the notes were opened for -- not
      // hardcoded FAILED, so pressing 'b' then Ctrl+Enter stays BLOCKED. No need to clear
      // failureNotes here -- the case-load effect below re-syncs it from the (about to
      // change) active case either way, whether that's this case's now-saved note or the
      // next case's own note after advancing.
      submitVerdict(pendingVerdictRef.current, notesText);
      notesDirtyRef.current = false;
      // Advance by suite-tree order, not raw array order -- finishing the last case in a
      // folder jumps straight to the first case in the next folder that has one, skipping
      // empty folders with no special-casing needed; finishing the very last case overall
      // wraps around to the first case in the first folder instead of just stopping.
      // If the active case is hidden by a search/filter it isn't in the order at all --
      // jump to the first visible case instead of doing nothing.
      const nextIdx =
        nextExecutionCaseIndex(executionCaseOrderByCaseIndex, selectedIndex) ??
        (executionCaseOrderByCaseIndex.includes(selectedIndex) ? null : executionCaseOrderByCaseIndex[0] ?? null);
      if (nextIdx !== null) setSelectedIndex(nextIdx);
    },
    onToggleStepDrawer: () => setShowStepDrawer((prev) => !prev),
    onToggleSuiteExpand: () => {
      showToast("Toggled suite folder tree state ([ / ])");
    },
    onFocusSearch: () => {
      if (searchInputRef.current) searchInputRef.current.focus();
    },
    onPermissionDeniedToast: (msg) => showToast(msg),
    notesInputRef,
  });

  // Moving to a different case should show THAT case's own saved notes (if it already has
  // any from a prior execution), not the previous case's leftover draft text -- any
  // unsubmitted draft was already saved by the textarea's onBlur handler above (which fires
  // as focus leaves it, before selectedIndex actually changes). Loading an existing note
  // here is not a user edit, so notesDirtyRef stays false (nothing to resubmit on blur
  // unless the user actually changes it).
  useEffect(() => {
    setFailureNotes(activeCase?.latest_notes || "");
    notesDirtyRef.current = false;
    // A note-only Ctrl+Enter (no verdict hotkey pressed since arriving on this case) should
    // resubmit whatever verdict the case already has, not silently reassign it -- e.g.
    // navigating to an already-SKIPPED case and just adding a note must not flip it to
    // FAILED. Only default to FAILED for a genuinely UNTESTED case, matching the existing
    // convention that an explain-why note with no verdict chosen yet implies a failure.
    const existingVerdict = activeCase?.latest_verdict;
    pendingVerdictRef.current =
      existingVerdict && existingVerdict !== "UNTESTED"
        ? (existingVerdict as VerdictType)
        : "FAILED";
  }, [selectedIndex, activeCase?.latest_notes, activeCase?.latest_verdict]);

  if (authChecking) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          backgroundColor: "#090d16",
          color: "#9ca3af",
          fontFamily: "Inter, sans-serif",
          fontSize: "14px",
        }}
      >
        ⚡ Initializing Testify...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginPage
        onLoginSuccess={(user, _token) => {
          setCurrentUser(user);
          setUserPermissions(user.permissions || []);
          showToast(`Welcome back, ${user.username}!`);
          // No explicit loadWorkspace() call needed here -- the currentUser-keyed effects
          // above pick up the new session and load projects/plans/workspace automatically.
        }}
      />
    );
  }

  if (!workspace) {
    return (
      <div
        style={{
          padding: "40px",
          textAlign: "center",
          color: "#9ca3af",
          backgroundColor: "#090d16",
          height: "100vh",
        }}
      >
        Loading High-Density Workspace...
      </div>
    );
  }

  // Calculate Pass/Fail ratio metrics for Pane 1
  const passedCount = workspace.cases.filter(
    (c) => c.latest_verdict === "PASSED",
  ).length;
  const failedCount = workspace.cases.filter(
    (c) => c.latest_verdict === "FAILED",
  ).length;

  // Build the real, nested SuiteTreeNode hierarchy from the Specification-mode spec-tree
  // fetch, which drives Pane 1 in BOTH modes (fixes the tree's pre-existing flat/fake-count
  // display). Execution mode's pass/fail counts are computed per-suite from the current
  // plan's cases (workspace.cases); Specification mode's in-plan/total counts come straight
  // from the server (spec-tree already sums them recursively over each subtree).
  const execCountsBySuite = new Map<string, { passed: number; total: number }>();
  if (workspaceMode === "EXECUTION") {
    for (const c of workspace.cases) {
      if (!c.test_suite_id) continue;
      const entry = execCountsBySuite.get(c.test_suite_id) || { passed: 0, total: 0 };
      entry.total += 1;
      if (c.latest_verdict === "PASSED") entry.passed += 1;
      execCountsBySuite.set(c.test_suite_id, entry);
    }
  }

  const buildSuiteNodes = (nodes: SpecSuiteNode[]): SuiteTreeNode[] =>
    nodes.map((n) => {
      const exec = execCountsBySuite.get(n.id);
      return {
        id: n.id,
        name: n.name,
        path: n.path,
        parentId: n.parent_suite_id,
        children: buildSuiteNodes(n.children),
        passedCount: exec?.passed ?? 0,
        totalCount: exec?.total ?? 0,
        inPlanCount: n.in_plan_count,
        totalCaseCount: n.total_case_count,
      };
    });

  // With a search/filter active the tree only shows suites containing a match (plus their
  // ancestors, which suite_ids already includes) -- counts stay the suite's real totals.
  const suiteNodes: SuiteTreeNode[] = specData
    ? buildSuiteNodes(filterResult ? pruneSuiteTree(specData.suites, filterResult.suiteIds) : specData.suites)
    : [];

  // Backs Pane 3's Suite Details view below -- selectedSuiteId only carries an id, so the
  // full node (name, case counts) has to be looked up from the nested tree each render.
  function findSuiteNode(nodes: SpecSuiteNode[], suiteId: string): SpecSuiteNode | null {
    for (const node of nodes) {
      if (node.id === suiteId) return node;
      const found = findSuiteNode(node.children, suiteId);
      if (found) return found;
    }
    return null;
  }
  const specActiveSuite =
    workspaceMode === "SPECIFICATION" && selectedSuiteId && specData
      ? findSuiteNode(specData.suites, selectedSuiteId)
      : null;

  // Flat, indented "Parent Suite" <select> option list for the suite create/rename form.
  function flattenSuiteOptions(
    nodes: SuiteTreeNode[],
    depth = 0,
  ): Array<{ id: string; label: string }> {
    let result: Array<{ id: string; label: string }> = [];
    for (const node of nodes) {
      result.push({ id: node.id, label: `${"—".repeat(depth)} ${node.name}` });
      if (node.children && node.children.length > 0) {
        result = result.concat(flattenSuiteOptions(node.children, depth + 1));
      }
    }
    return result;
  }

  // Execution mode's Ctrl+Enter "jump to next folder" advance (see onSubmitNotes below)
  // needs cases ordered by suite-tree position -- see buildExecutionCaseOrder's own comment
  // for why workspace.cases' own order can't be used directly.
  const executionCaseOrderByCaseIndex: number[] =
    workspaceMode === "EXECUTION" && workspace
      ? buildExecutionCaseOrder(workspace.cases, flattenSuiteOptions(suiteNodes).map((s) => s.id)).filter(
          // Ctrl+Enter's next-folder jump only ever lands on cases the filter shows.
          (i) => !filterResult || visibleCaseIndexSet.has(i),
        )
      : [];

  const hasExecuteRunPermission = userPermissions.includes("EXECUTE_RUN");
  const hasUserManagePermission =
    userPermissions.includes("USER_MANAGE") ||
    userPermissions.includes("SYSTEM_ADMIN");
  const hasPlanManagePermission =
    userPermissions.includes("PLAN_MANAGE") ||
    userPermissions.includes("SYSTEM_ADMIN");
  const hasSpecCreatePermission =
    userPermissions.includes("SPEC_CREATE") || userPermissions.includes("SYSTEM_ADMIN");
  const hasSpecEditPermission =
    userPermissions.includes("SPEC_EDIT") || userPermissions.includes("SYSTEM_ADMIN");
  const hasSpecApprovePermission =
    userPermissions.includes("SPEC_APPROVE") || userPermissions.includes("SYSTEM_ADMIN");
  const hasSpecDeletePermission =
    userPermissions.includes("SPEC_DELETE") || userPermissions.includes("SYSTEM_ADMIN");
  const hasImportDataPermission =
    userPermissions.includes("IMPORT_DATA") || userPermissions.includes("SYSTEM_ADMIN");
  const hasExportDataPermission =
    userPermissions.includes("EXPORT_DATA") || userPermissions.includes("SYSTEM_ADMIN");
  const hasSpecViewPermission =
    userPermissions.includes("SPEC_VIEW") || userPermissions.includes("SYSTEM_ADMIN");

  const specActiveCase = specData?.cases.find((c) => c.id === specSelectedCaseId) || null;
  const specVersionDetail = specCaseDetail?.version || null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: "#090d16",
      }}
    >
      {/* AUTH, ADMIN, & ENTITY MODALS */}
      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        currentUser={currentUser}
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          setUserPermissions(user.permissions || []);
          showToast(
            `Welcome back, ${user.username}! Signed in as ${user.global_role}.`,
          );
        }}
        onUpdateCredentialsSuccess={(updatedUser) => {
          setCurrentUser(updatedUser);
        }}
      />

      <AdminPanelModal
        isOpen={adminPanelOpen}
        onClose={() => setAdminPanelOpen(false)}
        currentUser={currentUser}
        projects={projectsList}
        onSelfPermissionsChanged={fetchCurrentUser}
      />

      <ImportWizardModal
        isOpen={importWizardOpen}
        onClose={() => setImportWizardOpen(false)}
        currentUser={currentUser}
        projects={projectsList}
        defaultProjectId={selectedProjectId}
        onImportComplete={refreshSpecTree}
      />

      <ExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        currentUser={currentUser}
        projects={projectsList}
        defaultProjectId={selectedProjectId}
      />

      <ReportingModal
        isOpen={reportingModalOpen}
        onClose={() => setReportingModalOpen(false)}
        currentUser={currentUser}
        projects={projectsList}
        defaultProjectId={selectedProjectId}
      />

      <EntityManagementModal
        isOpen={entityModalOpen}
        onClose={() => setEntityModalOpen(false)}
        entityType={modalEntityType}
        actionType={modalActionType}
        selectedItem={modalSelectedItem}
        onSave={handleSaveEntity}
      />

      {/* TOAST NOTIFICATION OVERLAY */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            bottom: "20px",
            right: "20px",
            zIndex: 9999,
            backgroundColor: "#1e293b",
            color: "#f87171",
            border: "1px solid #ef4444",
            padding: "8px 16px",
            borderRadius: "6px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          {toastMessage}
        </div>
      )}

      {/* TOP HEADER */}
      <header
        style={{
          minHeight: "48px",
          backgroundColor: "#0d111c",
          borderBottom: "1px solid #1f2937",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          fontSize: "12px",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        {/* ENTITY DROPDOWNS & ACTIONS (PROJECT, PLAN, RUN) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontWeight: 800,
              color: "#3b82f6",
              letterSpacing: "0.5px",
              fontSize: "13px",
            }}
          >
            ⚡ TESTIFY
          </span>
          <span style={{ color: "#374151" }}>|</span>

          {/* PROJECT SELECT & ACTIONS */}
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ color: "#9ca3af", fontWeight: 600 }}>Project:</span>
            <select
              value={selectedProjectId}
              onChange={(e) => handleSelectProject(e.target.value)}
              style={{
                backgroundColor: "#1e293b",
                color: "#f8fafc",
                border: "1px solid #334155",
                borderRadius: "4px",
                padding: "3px 6px",
                fontSize: "11px",
                fontWeight: 600,
                outline: "none",
                cursor: "pointer",
              }}
            >
              {projectsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.prefix})
                </option>
              ))}
            </select>
            <button
              onClick={() => openEntityModal("PROJECT", "CREATE")}
              title="Create New Project"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              ➕
            </button>
            <button
              onClick={() => openEntityModal("PROJECT", "EDIT")}
              title="Edit Selected Project"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              ✏️
            </button>
            <button
              onClick={() => openEntityModal("PROJECT", "DELETE")}
              title="Delete Selected Project"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              🗑️
            </button>
          </div>

          <span style={{ color: "#374151" }}>|</span>

          {/* PLAN SELECT & ACTIONS */}
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ color: "#9ca3af", fontWeight: 600 }}>Plan:</span>
            <select
              value={selectedPlanId}
              onChange={(e) => handleSelectPlan(e.target.value)}
              style={{
                backgroundColor: "#1e293b",
                color: "#f8fafc",
                border: "1px solid #334155",
                borderRadius: "4px",
                padding: "3px 6px",
                fontSize: "11px",
                fontWeight: 600,
                outline: "none",
                cursor: "pointer",
              }}
            >
              {plansList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} [{p.status}]
                </option>
              ))}
            </select>
            <button
              onClick={() => openEntityModal("PLAN", "CREATE")}
              title="Create New Test Plan"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              ➕
            </button>
            <button
              onClick={() => openEntityModal("PLAN", "EDIT")}
              title="Edit Selected Test Plan"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              ✏️
            </button>
            <button
              onClick={() => selectedPlanId && handleDeletePlanClick(selectedPlanId)}
              title="Delete Selected Test Plan"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              🗑️
            </button>
          </div>

          <span style={{ color: "#374151" }}>|</span>

          {/* RUN SELECT & ACTIONS */}
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ color: "#9ca3af", fontWeight: 600 }}>Run:</span>
            <select
              value={selectedRunId}
              onChange={(e) => handleSelectRun(e.target.value)}
              style={{
                backgroundColor: "#1e293b",
                color: "#f8fafc",
                border: "1px solid #334155",
                borderRadius: "4px",
                padding: "3px 6px",
                fontSize: "11px",
                fontWeight: 600,
                outline: "none",
                cursor: "pointer",
              }}
            >
              {runsList.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} [{r.status}]
                </option>
              ))}
            </select>
            <button
              onClick={() => (selectedPlanId ? openEntityModal("RUN", "CREATE") : setNoPlanSetWarning(true))}
              title="Create New Test Run"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              ➕
            </button>
            <button
              onClick={() => openEntityModal("RUN", "EDIT")}
              title="Edit Selected Test Run"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              ✏️
            </button>
            <button
              onClick={() => selectedRunId && handleDeleteRunClick(selectedRunId)}
              title="Delete Selected Test Run"
              style={{
                background: "transparent",
                border: "none",
                padding: "2px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              🗑️
            </button>
          </div>
        </div>

        {/* USER WIDGET & ADMIN PANEL */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {hasImportDataPermission && (
            <button
              onClick={() => setImportWizardOpen(true)}
              style={{
                backgroundColor: "#0ea5e9",
                color: "#ffffff",
                border: "none",
                padding: "4px 10px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              📥 Import
            </button>
          )}
          {hasExportDataPermission && (
            <button
              onClick={() => setExportModalOpen(true)}
              style={{
                backgroundColor: "#0ea5e9",
                color: "#ffffff",
                border: "none",
                padding: "4px 10px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              📤 Export
            </button>
          )}
          {hasSpecViewPermission && (
            <button
              onClick={() => setReportingModalOpen(true)}
              style={{
                backgroundColor: "#0ea5e9",
                color: "#ffffff",
                border: "none",
                padding: "4px 10px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              📊 Reports
            </button>
          )}
          {hasUserManagePermission && (
            <button
              onClick={() => setAdminPanelOpen(true)}
              style={{
                backgroundColor: "#7c3aed",
                color: "#ffffff",
                border: "none",
                padding: "4px 10px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              🛡️ Admin Panel
            </button>
          )}

          {/* USER PROFILE WIDGET */}
          {currentUser ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                onClick={() => setAuthModalOpen(true)}
                style={{
                  backgroundColor: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: "4px",
                  padding: "3px 8px",
                  color: "#f8fafc",
                  fontSize: "11px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>
                  👤 <strong>{currentUser.username}</strong>
                </span>
                <span
                  style={{
                    backgroundColor:
                      currentUser.global_role === "Admin"
                        ? "#6d28d9"
                        : "#0284c7",
                    color: "#fff",
                    padding: "1px 5px",
                    borderRadius: "3px",
                    fontSize: "9px",
                    fontWeight: 700,
                  }}
                >
                  {currentUser.global_role}
                </span>
              </button>
              <button
                onClick={handleLogout}
                style={{
                  backgroundColor: "transparent",
                  border: "1px solid #475569",
                  color: "#94a3b8",
                  padding: "3px 6px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  cursor: "pointer",
                }}
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAuthModalOpen(true)}
              style={{
                backgroundColor: "#0284c7",
                color: "#ffffff",
                border: "none",
                padding: "4px 12px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              🔑 Sign In
            </button>
          )}
        </div>
      </header>

      {deletePlanPrompt && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Confirm Deletion
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>{deletePlanPrompt.detail}</div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setDeletePlanPrompt(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDeletePlan}
              style={{
                padding: "5px 12px",
                backgroundColor: "#dc2626",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete Anyway
            </button>
          </div>
        </div>
      )}

      {deleteRunPrompt && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Confirm Deletion
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>{deleteRunPrompt.detail}</div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setDeleteRunPrompt(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDeleteRun}
              style={{
                padding: "5px 12px",
                backgroundColor: "#dc2626",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete Anyway
            </button>
          </div>
        </div>
      )}

      {noPlanSetWarning && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ No test plan set
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>
            Select or create a test plan before creating a test run
          </div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setNoPlanSetWarning(false)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* 3-PANE TOPOLOGY WORKSPACE */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* PANE 1: RECURSIVE TREE NAVIGATION (28px NODE DENSITY) */}
        <div
          style={{
            width: `${suiteTreeWidth}px`,
            backgroundColor: "#0d111c",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid #1f2937",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "#6b7280",
                textTransform: "uppercase",
              }}
            >
              SUITE TREE
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {workspaceMode === "SPECIFICATION" && hasSpecCreatePermission && (
                <button
                  onClick={() => openCreateSuiteForm(null)}
                  title="Create a new top-level suite"
                  style={{
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "11px",
                    fontWeight: 700,
                    cursor: "pointer",
                    backgroundColor: "transparent",
                    color: "#60a5fa",
                  }}
                >
                  + Suite
                </button>
              )}
              {/* SPECIFICATION / EXECUTION MODE TOGGLE -- visible to any authenticated user
                  (per-case/suite plan-inclusion buttons are the part gated by PLAN_MANAGE,
                  not this toggle itself). */}
              <div
                style={{
                  display: "flex",
                  border: "1px solid #334155",
                  borderRadius: "4px",
                  overflow: "hidden",
                }}
              >
                {(["EXECUTION", "SPECIFICATION"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setWorkspaceMode(m)}
                    style={{
                      border: "none",
                      padding: "3px 8px",
                      fontSize: "10px",
                      fontWeight: 700,
                      cursor: "pointer",
                      backgroundColor: workspaceMode === m ? "#3b82f6" : "#1e293b",
                      color: workspaceMode === m ? "#ffffff" : "#9ca3af",
                    }}
                  >
                    {m === "EXECUTION" ? "Execute" : "Spec"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <CaseFilterPanel
            value={caseFilter}
            onChange={setCaseFilter}
            fields={caseFilterFields}
            mode={workspaceMode}
            hasPlan={Boolean(selectedPlanId)}
            hasRun={Boolean(selectedRunId)}
            searchInputRef={searchInputRef}
            matchCount={
              filterResult
                ? workspaceMode === "EXECUTION"
                  ? visibleCaseIndices.length
                  : filterResult.caseIds.size
                : null
            }
            totalCount={
              workspaceMode === "EXECUTION" ? workspace?.cases.length || 0 : specData?.cases.length || 0
            }
            onRequestFields={loadCaseFilterFields}
          />
          {filterError && (
            <div style={{ padding: "4px 12px", fontSize: "10px", color: "#f87171", borderBottom: "1px solid #1f2937" }}>
              {filterError}
            </div>
          )}

          {workspaceMode === "SPECIFICATION" && suiteFormState && (
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #1f2937",
                backgroundColor: "#111827",
              }}
            >
              <div style={{ fontSize: "11px", fontWeight: 600, color: "#e5e7eb", marginBottom: "6px" }}>
                {suiteFormState.mode === "CREATE" ? "New Suite" : "Rename / Move Suite"}
              </div>
              <input
                type="text"
                placeholder="Suite name"
                value={suiteFormState.name}
                onChange={(e) => setSuiteFormState((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && suiteFormState.name.trim() && !isSavingSuiteForm) handleSaveSuiteForm();
                }}
                autoFocus
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "5px 8px",
                  marginBottom: "6px",
                  backgroundColor: "#0d111c",
                  border: "1px solid #1f2937",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "12px",
                }}
              />
              <select
                value={suiteFormState.parentSuiteId ?? ""}
                onChange={(e) =>
                  setSuiteFormState((prev) => (prev ? { ...prev, parentSuiteId: e.target.value || null } : prev))
                }
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "5px 8px",
                  marginBottom: "6px",
                  backgroundColor: "#0d111c",
                  border: "1px solid #1f2937",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "12px",
                }}
              >
                <option value="">(Top-level, no parent)</option>
                {flattenSuiteOptions(suiteNodes).map((o) => (
                  <option key={o.id} value={o.id} disabled={o.id === suiteFormState.targetId}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => setSuiteFormState(null)}
                  style={{
                    flex: 1,
                    padding: "5px",
                    backgroundColor: "#334155",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSuiteForm}
                  disabled={isSavingSuiteForm || !suiteFormState.name.trim()}
                  style={{
                    flex: 1,
                    padding: "5px",
                    backgroundColor: isSavingSuiteForm ? "#166534" : "#16a34a",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: isSavingSuiteForm ? "default" : "pointer",
                  }}
                >
                  {isSavingSuiteForm ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          )}

          {workspaceMode === "SPECIFICATION" && deleteSuitePrompt && (
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #92400e",
                backgroundColor: "#78350f",
              }}
            >
              <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, marginBottom: "6px" }}>
                ⚠️ Confirm Deletion
              </div>
              <div style={{ fontSize: "11px", color: "#fde68a", marginBottom: "8px", lineHeight: 1.4 }}>
                {deleteSuitePrompt.detail}
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => setDeleteSuitePrompt(null)}
                  style={{
                    flex: 1,
                    padding: "5px",
                    backgroundColor: "#334155",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDeleteSuite}
                  style={{
                    flex: 1,
                    padding: "5px",
                    backgroundColor: "#dc2626",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Delete Anyway
                </button>
              </div>
            </div>
          )}

          <VirtualizedSuiteTree
            suites={suiteNodes}
            selectedSuiteId={selectedSuiteId}
            activeSuiteId={
              workspaceMode === "EXECUTION" ? activeCase?.test_suite_id || null : null
            }
            onSelectSuite={(suiteId) => {
              // Deliberately not a toggle -- clicking the already-selected suite again must
              // not deselect it (per direct request). Re-selecting the same suite is still
              // useful on its own: in Specification mode it switches Pane 3 back to that
              // suite's details if a case was being viewed instead.
              setSelectedSuiteId(suiteId);
              if (workspaceMode === "SPECIFICATION") setSpecSelectedCaseId(null);
            }}
            mode={workspaceMode}
            canManagePlan={hasPlanManagePermission}
            onToggleSuiteInclusion={handleToggleSuiteInclusion}
            canCreateSuites={hasSpecCreatePermission}
            canEditSuites={hasSpecEditPermission}
            canDeleteSuites={hasSpecDeletePermission}
            onCreateChildSuite={(parentId) => openCreateSuiteForm(parentId)}
            onRenameSuite={(suiteId, name, parentId) => openRenameSuiteForm(suiteId, name, parentId)}
            onDeleteSuite={(suiteId) => handleDeleteSuiteClick(suiteId)}
          />
        </div>

        {/* DIVIDER: PANE 1 / PANE 2 */}
        <div
          onMouseDown={handleDividerMouseDown("tree")}
          onMouseEnter={() => setHoveredDivider("tree")}
          onMouseLeave={() => setHoveredDivider(null)}
          style={dividerStyle("tree")}
        />

        {/* PANE 2: TEST CASE QUEUE GRID (32px ROW DENSITY) */}
        <div
          style={{
            width: `${queueGridWidth}px`,
            backgroundColor: "#111827",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid #1f2937",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "#6b7280",
                textTransform: "uppercase",
              }}
            >
              {workspaceMode === "SPECIFICATION" ? "SPECIFICATION" : "QUEUE GRID"}
            </span>
            {workspaceMode === "SPECIFICATION" ? (
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                  {specCasesForSuite.filter((c) => c.in_plan).length}/{specCasesForSuite.length} in plan
                </span>
                {hasSpecCreatePermission && (
                  <button
                    onClick={() => setIsCaseCreateFormOpen((prev) => !prev)}
                    disabled={!selectedSuiteId}
                    title={selectedSuiteId ? "Create a new case in the selected suite" : "Select a suite first"}
                    style={{
                      border: "1px solid #334155",
                      borderRadius: "4px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      fontWeight: 700,
                      cursor: selectedSuiteId ? "pointer" : "not-allowed",
                      backgroundColor: "transparent",
                      color: selectedSuiteId ? "#60a5fa" : "#4b5563",
                    }}
                  >
                    + Case
                  </button>
                )}
              </span>
            ) : (
              <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                <span style={{ color: "#10b981" }}>{passedCount} Pass</span> |{" "}
                <span style={{ color: "#ef4444" }}>{failedCount} Fail</span>
              </span>
            )}
          </div>

          {workspaceMode === "SPECIFICATION" && isCaseCreateFormOpen && selectedSuiteId && (
            <div style={{ padding: "10px 12px", borderBottom: "1px solid #1f2937", backgroundColor: "#0d111c" }}>
              <input
                type="text"
                placeholder="New case title"
                value={newCaseTitle}
                onChange={(e) => setNewCaseTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newCaseTitle.trim() && !isCreatingCase) handleCreateCase();
                }}
                autoFocus
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "5px 8px",
                  marginBottom: "6px",
                  backgroundColor: "#111827",
                  border: "1px solid #1f2937",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "12px",
                }}
              />
              <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
                <select
                  value={newCasePriority}
                  onChange={(e) => setNewCasePriority(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "5px 8px",
                    backgroundColor: "#111827",
                    border: "1px solid #1f2937",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                >
                  {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select
                  value={newCaseExecutionType}
                  onChange={(e) => setNewCaseExecutionType(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "5px 8px",
                    backgroundColor: "#111827",
                    border: "1px solid #1f2937",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                >
                  {["MANUAL", "AUTOMATED"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => setIsCaseCreateFormOpen(false)}
                  style={{
                    flex: 1,
                    padding: "5px",
                    backgroundColor: "#334155",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateCase}
                  disabled={isCreatingCase || !newCaseTitle.trim()}
                  style={{
                    flex: 1,
                    padding: "5px",
                    backgroundColor: isCreatingCase ? "#166534" : "#16a34a",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: isCreatingCase ? "default" : "pointer",
                  }}
                >
                  {isCreatingCase ? "Creating..." : "Create Case"}
                </button>
              </div>
            </div>
          )}

          {filterResult &&
            (workspaceMode === "SPECIFICATION" ? specCasesForSuite.length === 0 : visibleCaseIndices.length === 0) && (
              <div style={{ padding: "16px 12px", fontSize: "11px", color: "#6b7280", textAlign: "center" }}>
                {workspaceMode === "SPECIFICATION" && selectedSuiteId
                  ? "No cases in this suite match the current search/filters."
                  : "No cases match the current search/filters."}
              </div>
            )}
          {workspaceMode === "SPECIFICATION" ? (
            <SpecCaseListGrid
              cases={specCasesForSuite}
              selectedCaseId={specSelectedCaseId}
              onSelectCase={(caseId) => setSpecSelectedCaseId(caseId)}
              canManagePlan={hasPlanManagePermission}
              onToggleInclusion={handleToggleCaseInclusion}
              pendingCaseId={pendingToggleId}
            />
          ) : (
            <TestCaseQueueGrid
              cases={
                filterResult ? visibleCaseIndices.map((i) => workspace.cases[i]) : workspace.cases
              }
              selectedIndex={selectedVisiblePos}
              onSelectCase={(pos) => {
                const target = visibleCaseIndices[pos];
                if (target !== undefined) setSelectedIndex(target);
              }}
            />
          )}
        </div>

        {/* DIVIDER: PANE 2 / PANE 3 */}
        <div
          onMouseDown={handleDividerMouseDown("queue")}
          onMouseEnter={() => setHoveredDivider("queue")}
          onMouseLeave={() => setHoveredDivider(null)}
          style={dividerStyle("queue")}
        />

        {/* PANE 3: EXECUTION & DETAIL WORKSPACE (FLUID) */}
        <div
          style={{
            flex: 1,
            backgroundColor: "#0d111c",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {workspaceMode === "SPECIFICATION" ? (
            specActiveCase ? (
              <>
                {/* SPEC CASE HEADER + PLAN-INCLUSION TOGGLE */}
                <div
                  style={{
                    padding: "16px 20px",
                    borderBottom: "1px solid #1f2937",
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                  }}
                >
                  {/* Row 1: id + title, the title stretching all the way to the action
                      buttons. Row 2 (always its own line): priority, execution type, version
                      badge, Approve. */}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      marginRight: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "#f9fafb", flexShrink: 0 }}>
                      {specActiveCase.external_id}
                    </span>
                    <input
                      key={specActiveCase.id}
                      type="text"
                      defaultValue={specActiveCase.title}
                      onBlur={(e) => {
                        if (e.target.value !== specActiveCase.title) {
                          handleUpdateCaseField("title", e.target.value);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      disabled={!hasSpecEditPermission}
                      title={hasSpecEditPermission ? "Case title" : "Requires SPEC_EDIT permission"}
                      style={{
                        fontSize: "14px",
                        color: "#f8fafc",
                        backgroundColor: hasSpecEditPermission ? "#111827" : "transparent",
                        border: hasSpecEditPermission ? "1px solid #1f2937" : "none",
                        borderRadius: "4px",
                        padding: hasSpecEditPermission ? "3px 8px" : "0",
                        flex: 1,
                        minWidth: 0,
                        opacity: hasSpecEditPermission ? 1 : 0.85,
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <select
                      value={specActiveCase.priority}
                      onChange={(e) => handleUpdateCaseField("priority", e.target.value)}
                      disabled={!hasSpecEditPermission}
                      style={{
                        fontSize: "11px",
                        backgroundColor: "#111827",
                        border: "1px solid #1f2937",
                        borderRadius: "4px",
                        color: "#f8fafc",
                        padding: "3px 6px",
                        opacity: hasSpecEditPermission ? 1 : 0.6,
                      }}
                    >
                      {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <select
                      value={specActiveCase.execution_type ?? "MANUAL"}
                      onChange={(e) => handleUpdateCaseField("execution_type", e.target.value)}
                      disabled={!hasSpecEditPermission}
                      style={{
                        fontSize: "11px",
                        backgroundColor: "#111827",
                        border: "1px solid #1f2937",
                        borderRadius: "4px",
                        color: "#f8fafc",
                        padding: "3px 6px",
                        opacity: hasSpecEditPermission ? 1 : 0.6,
                      }}
                    >
                      {["MANUAL", "AUTOMATED"].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    {specActiveCase.latest_version && (
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          backgroundColor:
                            specActiveCase.latest_version.status === "APPROVED"
                              ? "#064e3b"
                              : "#1f2937",
                          color:
                            specActiveCase.latest_version.status === "APPROVED"
                              ? "#34d399"
                              : "#9ca3af",
                          fontWeight: 600,
                        }}
                      >
                        v{specActiveCase.latest_version.version_number}{" "}
                        {specActiveCase.latest_version.status}
                      </span>
                    )}
                    {specActiveCase.latest_version?.status === "DRAFT" && hasSpecApprovePermission && (
                      <button
                        onClick={handleApproveVersion}
                        disabled={isApprovingVersion}
                        style={{
                          fontSize: "11px",
                          padding: "3px 8px",
                          borderRadius: "4px",
                          border: "1px solid #22c55e",
                          backgroundColor: "rgba(34, 197, 94, 0.12)",
                          color: "#4ade80",
                          fontWeight: 700,
                          cursor: isApprovingVersion ? "default" : "pointer",
                        }}
                      >
                        {isApprovingVersion ? "Approving…" : "✓ Approve"}
                      </button>
                    )}
                  </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                    {/* The plan-inclusion toggle used to live here ("+ Add to Plan"/"✓ In Plan"),
                        but every case already has the identical toggle on its own row in the
                        case list (SpecCaseListGrid's onToggleInclusion/pendingCaseId -- same
                        handleToggleCaseInclusion/pendingToggleId state) -- removed as a
                        duplicate, per direct request, and replaced with the Edit action moved
                        here from up by the version badge, so it sits next to Delete instead. */}
                    {specActiveCase.latest_version?.status === "APPROVED" && hasSpecEditPermission && (
                      <button
                        onClick={handleCreateDraft}
                        disabled={isCreatingDraft}
                        title="Create a new draft to edit this case"
                        style={{
                          flexShrink: 0,
                          padding: "6px 14px",
                          borderRadius: "4px",
                          fontSize: "12px",
                          fontWeight: 700,
                          border: "1px solid #f59e0b",
                          backgroundColor: "rgba(245, 158, 11, 0.12)",
                          color: "#fbbf24",
                          cursor: isCreatingDraft ? "default" : "pointer",
                        }}
                      >
                        {isCreatingDraft ? "Creating…" : "Edit"}
                      </button>
                    )}
                    {hasSpecDeletePermission && (
                      <button
                        onClick={() => handleDeleteCaseClick(specActiveCase.id)}
                        title="Delete case"
                        style={{
                          flexShrink: 0,
                          padding: "6px 10px",
                          borderRadius: "4px",
                          fontSize: "12px",
                          border: "1px solid #4b5563",
                          backgroundColor: "transparent",
                          color: "#f87171",
                          cursor: "pointer",
                        }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>

                {deleteCasePrompt && deleteCasePrompt.id === specActiveCase.id && (
                  <div style={{ padding: "12px 20px", borderBottom: "1px solid #92400e", backgroundColor: "#78350f" }}>
                    <div style={{ fontSize: "12px", color: "#fbbf24", fontWeight: 600, marginBottom: "6px" }}>
                      ⚠️ Confirm Deletion
                    </div>
                    <div style={{ fontSize: "12px", color: "#fde68a", marginBottom: "10px", lineHeight: 1.4 }}>
                      {deleteCasePrompt.detail}
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => setDeleteCasePrompt(null)}
                        style={{ padding: "6px 14px", backgroundColor: "#334155", border: "none", borderRadius: "4px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleConfirmDeleteCase}
                        style={{ padding: "6px 14px", backgroundColor: "#dc2626", border: "none", borderRadius: "4px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                      >
                        Delete Anyway
                      </button>
                    </div>
                  </div>
                )}

                {specEditError && (
                  <div style={{ padding: "8px 20px", fontSize: "12px", color: "#f87171", backgroundColor: "#111827", borderBottom: "1px solid #1f2937" }}>
                    ⚠️ {specEditError}
                  </div>
                )}

                {/* CASE DETAILS -- title/priority/execution_type (above) are always
                    editable; preconditions/summary/steps/custom fields below are editable
                    only while the latest version is DRAFT ("Edit" above unlocks this for
                    an APPROVED case by creating a new draft). Custom field *values* aren't
                    version-locked server-side (setValue works against any status, by
                    design -- see CLAUDE.md), but the UI still only offers editing them in
                    lockstep with everything else in this pane, matching how a locked case
                    reads as fully read-only rather than partially editable. */}
                <div ref={specDetailScrollRef} style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
                  {(() => {
                    const isDraft = specVersionDetail?.status === "DRAFT";
                    return (
                      <>
                        {(isDraft || specVersionDetail?.summary) && (
                          <div
                            style={{
                              marginBottom: "16px",
                              backgroundColor: "#111827",
                              padding: "12px",
                              borderRadius: "6px",
                              border: "1px solid #1f2937",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#6b7280",
                                textTransform: "uppercase",
                                marginBottom: "4px",
                              }}
                            >
                              Summary
                            </div>
                            {isDraft && hasSpecEditPermission ? (
                              <textarea
                                key={`sum-${specVersionDetail?.id}`}
                                ref={autoGrowTextarea}
                                defaultValue={specVersionDetail?.summary ?? ""}
                                onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                onBlur={(e) => handleSaveVersionContent("summary", e.target.value)}
                                rows={2}
                                style={{
                                  width: "100%",
                                  boxSizing: "border-box",
                                  fontSize: "12px",
                                  color: "#f8fafc",
                                  backgroundColor: "#0d111c",
                                  border: "1px solid #1f2937",
                                  borderRadius: "4px",
                                  padding: "6px 8px",
                                  resize: "none",
                                  overflow: "hidden",
                                }}
                              />
                            ) : (
                              <div style={{ fontSize: "12px", color: "#d1d5db" }}>
                                {specVersionDetail?.summary}
                              </div>
                            )}
                          </div>
                        )}

                        <div
                          style={{
                            marginBottom: "16px",
                            backgroundColor: "#111827",
                            padding: "12px",
                            borderRadius: "6px",
                            border: "1px solid #1f2937",
                          }}
                        >
                          <div
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color: "#6b7280",
                              textTransform: "uppercase",
                              marginBottom: "4px",
                            }}
                          >
                            Preconditions
                          </div>
                          {isDraft && hasSpecEditPermission ? (
                            <textarea
                              key={`pre-${specVersionDetail?.id}`}
                              ref={autoGrowTextarea}
                              defaultValue={specVersionDetail?.preconditions ?? ""}
                              onInput={(e) => autoGrowTextarea(e.currentTarget)}
                              onBlur={(e) => handleSaveVersionContent("preconditions", e.target.value)}
                              rows={2}
                              style={{
                                width: "100%",
                                boxSizing: "border-box",
                                fontSize: "12px",
                                color: "#f8fafc",
                                backgroundColor: "#0d111c",
                                border: "1px solid #1f2937",
                                borderRadius: "4px",
                                padding: "6px 8px",
                                resize: "none",
                                overflow: "hidden",
                              }}
                            />
                          ) : (
                            <div style={{ fontSize: "12px", color: "#d1d5db" }}>
                              {specVersionDetail?.preconditions || "—"}
                            </div>
                          )}
                        </div>

                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: "#6b7280",
                            textTransform: "uppercase",
                            marginBottom: "8px",
                          }}
                        >
                          Ordered Step Specification {isDraft ? "" : "(read-only)"}
                        </div>

                        {isDraft && hasSpecEditPermission ? (
                          <div>
                            {stepsDraft.map((step, i) => (
                              <div
                                key={step.id}
                                style={{
                                  display: "flex",
                                  gap: "6px",
                                  alignItems: "flex-start",
                                  marginBottom: "6px",
                                  backgroundColor: "#0d111c",
                                  border: "1px solid #1f2937",
                                  borderRadius: "4px",
                                  padding: "6px",
                                }}
                              >
                                <span style={{ fontSize: "11px", color: "#6b7280", padding: "6px 2px" }}>
                                  {i + 1}
                                </span>
                                <textarea
                                  ref={(el) => {
                                    stepActionRefs.current[i] = el;
                                    // Only auto-size on genuine mount (no inline height set yet), not on
                                    // every reattach -- this callback closes over `i`, so it's a fresh
                                    // function identity every render, and React detaches/reattaches it
                                    // for EVERY row (not just a changed one) on every commit that
                                    // touches this list. Calling autoGrowTextarea unconditionally here
                                    // meant every existing row got a synchronous forced-reflow resize on
                                    // every add/move/remove -- extra layout thrash interleaved with
                                    // exactly the commits the scroll-jump fixes above care about. Live
                                    // growth while typing is already covered by onInput below.
                                    if (el && !el.style.height) autoGrowTextarea(el);
                                  }}
                                  placeholder="Action"
                                  value={step.action}
                                  onChange={(e) => updateStepField(i, { action: e.target.value })}
                                  onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                  onBlur={() => { stepsScroll.captureScroll(); saveSteps(); }}
                                  rows={1}
                                  style={{
                                    flex: 1,
                                    fontSize: "12px",
                                    color: "#f8fafc",
                                    backgroundColor: "#111827",
                                    border: "1px solid #1f2937",
                                    borderRadius: "4px",
                                    padding: "5px 8px",
                                    resize: "none",
                                    overflow: "hidden",
                                  }}
                                />
                                <textarea
                                  ref={autoGrowTextarea}
                                  placeholder="Expected Result"
                                  value={step.expected_result}
                                  onChange={(e) => updateStepField(i, { expected_result: e.target.value })}
                                  onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                  onBlur={() => { stepsScroll.captureScroll(); saveSteps(); }}
                                  rows={1}
                                  style={{
                                    flex: 1,
                                    fontSize: "12px",
                                    color: "#a7f3d0",
                                    backgroundColor: "#111827",
                                    border: "1px solid #1f2937",
                                    borderRadius: "4px",
                                    padding: "5px 8px",
                                    resize: "none",
                                    overflow: "hidden",
                                  }}
                                />
                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                  <button
                                    onClick={() => moveStep(i, -1)}
                                    disabled={i === 0}
                                    title="Move up"
                                    style={{ background: "none", border: "none", color: i === 0 ? "#4b5563" : "#9ca3af", cursor: i === 0 ? "not-allowed" : "pointer", fontSize: "10px" }}
                                  >
                                    ▲
                                  </button>
                                  <button
                                    onClick={() => moveStep(i, 1)}
                                    disabled={i === stepsDraft.length - 1}
                                    title="Move down"
                                    style={{ background: "none", border: "none", color: i === stepsDraft.length - 1 ? "#4b5563" : "#9ca3af", cursor: i === stepsDraft.length - 1 ? "not-allowed" : "pointer", fontSize: "10px" }}
                                  >
                                    ▼
                                  </button>
                                </div>
                                <button
                                  onClick={() => removeStep(i)}
                                  title="Remove step"
                                  style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: "12px", padding: "6px 2px" }}
                                >
                                  🗑️
                                </button>
                              </div>
                            ))}
                            <button
                              onClick={addStep}
                              style={{
                                padding: "4px 10px",
                                backgroundColor: "transparent",
                                border: "1px dashed #475569",
                                borderRadius: "4px",
                                color: "#94a3b8",
                                fontSize: "11px",
                                cursor: "pointer",
                              }}
                            >
                              + Add Step
                            </button>
                            <div ref={stepsEndAnchorRef} />
                            {/* Always mounted (not conditionally rendered) so toggling it never changes
                                specDetailScrollRef's scrollHeight -- a conditionally-mounted version
                                growing/shrinking the container on every autosave was the primary cause
                                of the focus-swap/blur jitter: shrinking scrollHeight when a save
                                resolves makes the browser synchronously clamp scrollTop down, a visible
                                jump with no coordination from any of our own scroll-preservation code. */}
                            <div
                              aria-hidden={!isSavingSteps}
                              style={{
                                marginTop: "10px",
                                textAlign: "right",
                                fontSize: "11px",
                                color: "#6b7280",
                                opacity: isSavingSteps ? 1 : 0,
                                visibility: isSavingSteps ? "visible" : "hidden",
                              }}
                            >
                              Saving…
                            </div>
                          </div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                            <thead>
                              <tr
                                style={{
                                  borderBottom: "1px solid #1f2937",
                                  color: "#9ca3af",
                                  textAlign: "left",
                                }}
                              >
                                <th style={{ padding: "6px", width: "50px" }}>#</th>
                                <th style={{ padding: "6px" }}>Action</th>
                                <th style={{ padding: "6px" }}>Expected Result</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(specVersionDetail?.steps || []).map((step) => (
                                <tr
                                  key={step.id}
                                  style={{ borderBottom: "1px solid #1f2937", color: "#d1d5db" }}
                                >
                                  <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                                    {step.step_number}
                                  </td>
                                  <td style={{ padding: "8px 6px" }}>{step.action}</td>
                                  <td style={{ padding: "8px 6px", color: "#a7f3d0" }}>
                                    {step.expected_result}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {!specVersionDetail && (
                          <div style={{ marginTop: "12px", color: "#6b7280", fontSize: "12px" }}>
                            Loading step detail…
                          </div>
                        )}

                        {specCaseCustomFieldValues && specCaseCustomFieldValues.length > 0 && (
                          <div style={{ marginTop: "16px" }}>
                            {specCaseCustomFieldValues.map((entry) => (
                              <CustomFieldEditor
                                key={`${specSelectedCaseId}-${entry.definition.id}-${customFieldResetKeyById[entry.definition.id] ?? 0}`}
                                entry={entry}
                                onChange={(value) => handleCustomFieldValueChange(entry.definition.id, value)}
                                disabled={!(isDraft && hasPlanManagePermission)}
                                disabledTitle={
                                  !isDraft
                                    ? "Editable only while in Draft -- click Edit to create a new draft"
                                    : "Requires plan management permission"
                                }
                                errorMessage={customFieldErrorById[entry.definition.id] ?? null}
                                isSaving={savingCustomFieldId === entry.definition.id}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
            ) : specActiveSuite ? (
              <>
                {/* SUITE DETAILS -- name + custom fields. Replaces the case detail view
                    whenever a suite (not a case) is the current selection; clicking a case
                    in the list takes priority again (specActiveCase above), matching how
                    onSelectSuite/onSelectCase never clear each other's underlying id, only
                    which one this view prefers to show. This is now the only place a
                    suite's custom field values are shown/edited -- the tree's old "✎ Fields"
                    button (which opened a separate floating panel) was removed as redundant. */}
                <div
                  style={{
                    padding: "16px 20px",
                    borderBottom: "1px solid #1f2937",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "16px" }}>📁</span>
                    <input
                      key={specActiveSuite.id}
                      type="text"
                      defaultValue={specActiveSuite.name}
                      onBlur={(e) => {
                        if (e.target.value.trim() && e.target.value !== specActiveSuite.name) {
                          handleUpdateSuiteName(specActiveSuite.id, e.target.value.trim());
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      disabled={!hasSpecEditPermission}
                      title={hasSpecEditPermission ? "Suite name" : "Requires SPEC_EDIT permission"}
                      style={{
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#f9fafb",
                        backgroundColor: hasSpecEditPermission ? "#111827" : "transparent",
                        border: hasSpecEditPermission ? "1px solid #1f2937" : "none",
                        borderRadius: "4px",
                        padding: hasSpecEditPermission ? "3px 8px" : "0",
                        flex: 1,
                        minWidth: 0,
                        opacity: hasSpecEditPermission ? 1 : 0.85,
                      }}
                    />
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>
                    {specActiveSuite.total_case_count} case{specActiveSuite.total_case_count === 1 ? "" : "s"}
                    {" · "}
                    {specActiveSuite.in_plan_count} in plan
                  </div>
                </div>

                <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
                  {suiteCustomFieldValues && suiteCustomFieldValues.length > 0 ? (
                    suiteCustomFieldValues.map((entry) => (
                      <CustomFieldEditor
                        key={`${specActiveSuite.id}-${entry.definition.id}-${suiteCustomFieldResetKeyById[entry.definition.id] ?? 0}`}
                        entry={entry}
                        onChange={(value) => handleSuiteCustomFieldValueChange(entry.definition.id, value)}
                        disabled={!hasPlanManagePermission}
                        disabledTitle="Requires plan management permission"
                        errorMessage={suiteCustomFieldErrorById[entry.definition.id] ?? null}
                        isSaving={savingSuiteCustomFieldId === entry.definition.id}
                      />
                    ))
                  ) : suiteCustomFieldValues ? (
                    <div style={{ fontSize: "12px", color: "#6b7280" }}>
                      No custom fields defined for Test Suites yet.
                    </div>
                  ) : (
                    <div style={{ fontSize: "12px", color: "#6b7280" }}>Loading…</div>
                  )}
                </div>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#6b7280",
                  fontSize: "13px",
                }}
              >
                Select a test case or suite to view its details.
              </div>
            )
          ) : activeCase ? (
            <>
              {/* CASE HEADER WITH VISUAL HOTKEY STATUS BADGE */}
              <div
                style={{
                  padding: "16px 20px",
                  borderBottom: "1px solid #1f2937",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      marginBottom: "8px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#f9fafb",
                      }}
                    >
                      {activeCase.external_id}
                    </span>
                    <span style={{ fontSize: "14px", color: "#9ca3af" }}>
                      {activeCase.title}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        backgroundColor: "#064e3b",
                        color: "#34d399",
                        fontWeight: 600,
                      }}
                    >
                      v{activeCase.version_number} APPROVED
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#9ca3af" }}>
                    {activeCase.summary}
                  </div>
                </div>
              </div>

              {/* CASE DETAILS & STEP VERIFICATION */}
              <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
                <div
                  style={{
                    marginBottom: "16px",
                    backgroundColor: "#111827",
                    padding: "12px",
                    borderRadius: "6px",
                    border: "1px solid #1f2937",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "#6b7280",
                      textTransform: "uppercase",
                      marginBottom: "4px",
                    }}
                  >
                    Preconditions
                  </div>
                  <div style={{ fontSize: "12px", color: "#d1d5db" }}>
                    {activeCase.preconditions}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "8px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "#6b7280",
                      textTransform: "uppercase",
                    }}
                  >
                    Ordered Step Verification Table (Hotkey 'e' toggles drawer)
                  </span>
                  <button
                    onClick={() => setShowStepDrawer((prev) => !prev)}
                    style={{
                      backgroundColor: "#1f2937",
                      color: "#9ca3af",
                      border: "none",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      cursor: "pointer",
                    }}
                  >
                    {showStepDrawer ? "Hide Drawer" : "Show Drawer (e)"}
                  </button>
                </div>

                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "12px",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid #1f2937",
                        color: "#9ca3af",
                        textAlign: "left",
                      }}
                    >
                      <th style={{ padding: "6px", width: "50px" }}>#</th>
                      <th style={{ padding: "6px" }}>Action</th>
                      <th style={{ padding: "6px" }}>Expected Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeCase.steps.map((step) => (
                      <tr
                        key={step.id}
                        style={{
                          borderBottom: "1px solid #1f2937",
                          color: "#d1d5db",
                        }}
                      >
                        <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                          {step.step_number}
                        </td>
                        <td style={{ padding: "8px 6px" }}>{step.action}</td>
                        <td style={{ padding: "8px 6px", color: "#a7f3d0" }}>
                          {step.expected_result}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {execCaseCustomFieldValues && execCaseCustomFieldValues.length > 0 && (
                  <div style={{ marginTop: "16px" }}>
                    {execCaseCustomFieldValues.map((entry) => (
                      <CustomFieldEditor
                        key={`${activeExecCaseId}-${entry.definition.id}`}
                        entry={entry}
                        onChange={() => {}}
                        disabled
                        disabledTitle="Custom fields are read-only during execution -- edit them in Specification mode"
                      />
                    ))}
                  </div>
                )}

                {/* DETAILED EXECUTION STEP DRAWER */}
                {showStepDrawer && (
                  <div
                    style={{
                      marginTop: "16px",
                      padding: "12px",
                      backgroundColor: "#1e293b",
                      borderRadius: "6px",
                      border: "1px solid #3b82f6",
                      fontSize: "12px",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        color: "#60a5fa",
                        marginBottom: "6px",
                      }}
                    >
                      Step Detail Execution Drawer (e)
                    </div>
                    <div style={{ color: "#d1d5db" }}>
                      Inspect individual step-level actual logs, binary
                      artifacts, and defect attachments here.
                    </div>
                  </div>
                )}

                {/* NOTES & FAILURE REASON TEXTAREA (ZONE 4 INPUT) */}
                <div style={{ marginTop: "24px" }}>
                  <label
                    style={{
                      display: "block",
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "#6b7280",
                      textTransform: "uppercase",
                      marginBottom: "6px",
                    }}
                  >
                    Notes
                  </label>
                  <textarea
                    ref={notesInputRef}
                    value={failureNotes}
                    onChange={(e) => {
                      setFailureNotes(e.target.value);
                      notesDirtyRef.current = true;
                    }}
                    onFocus={() => fsm.setZone("TEXT_INPUT")}
                    onBlur={() => {
                      fsm.setZone("EXECUTION_CONTAINER");
                      // Unfocusing (click away, Tab, Esc) saves any unsubmitted notes
                      // instead of silently discarding them. notesDirtyRef (not the
                      // failureNotes state, which can be stale here -- see Ctrl+Enter's
                      // own .blur() call) is what prevents double-submitting. No need to
                      // clear failureNotes after submitting -- it's now this case's saved
                      // note, and should keep showing exactly that.
                      if (notesDirtyRef.current && failureNotes.trim()) {
                        submitVerdict(pendingVerdictRef.current, failureNotes);
                        notesDirtyRef.current = false;
                      }
                    }}
                    placeholder="Type execution details or notes here... Single-key hotkeys auto-pause while typing. Press Ctrl+Enter to submit."
                    style={{
                      width: "100%",
                      height: "80px",
                      backgroundColor: "#111827",
                      border: fsm.isInputFocused
                        ? "1px solid #3b82f6"
                        : "1px solid #1f2937",
                      borderRadius: "6px",
                      color: "#f9fafb",
                      padding: "10px",
                      fontSize: "12px",
                      boxSizing: "border-box",
                      outline: "none",
                    }}
                  />
                </div>
              </div>

              {/* DOCKED EXECUTION ACTION BAR */}
              <div
                style={{
                  height: "56px",
                  backgroundColor: "#111827",
                  borderTop: "1px solid #1f2937",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 20px",
                }}
              >
                {/* HOTKEY VERDICT BUTTONS */}
                <div style={{ display: "flex", gap: "10px" }}>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("PASSED");
                      // Covers the case this button doesn't auto-advance from (the last case
                      // in the list) -- without this, a note-only Ctrl+Enter afterward would
                      // resubmit whatever stale verdict pendingVerdictRef last held instead of
                      // PASSED, since staying on the same case means the case-load reset
                      // effect (keyed on selectedIndex) never re-runs to correct it.
                      pendingVerdictRef.current = "PASSED";
                      if (nextVisibleCaseIndex !== undefined)
                        setSelectedIndex(nextVisibleCaseIndex);
                    }}
                    style={{
                      backgroundColor: hasExecuteRunPermission
                        ? "#15803d"
                        : "#374151",
                      color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: "4px",
                      fontWeight: 600,
                      fontSize: "13px",
                      cursor: hasExecuteRunPermission
                        ? "pointer"
                        : "not-allowed",
                    }}
                  >
                    Pass
                  </button>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("FAILED");
                      pendingVerdictRef.current = "FAILED";
                      if (notesInputRef.current) notesInputRef.current.focus();
                    }}
                    style={{
                      backgroundColor: hasExecuteRunPermission
                        ? "#b91c1c"
                        : "#374151",
                      color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: "4px",
                      fontWeight: 600,
                      fontSize: "13px",
                      cursor: hasExecuteRunPermission
                        ? "pointer"
                        : "not-allowed",
                    }}
                  >
                    Fail
                  </button>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("BLOCKED");
                      pendingVerdictRef.current = "BLOCKED";
                      if (notesInputRef.current) notesInputRef.current.focus();
                    }}
                    style={{
                      backgroundColor: hasExecuteRunPermission
                        ? "#b45309"
                        : "#374151",
                      color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: "4px",
                      fontWeight: 600,
                      fontSize: "13px",
                      cursor: hasExecuteRunPermission
                        ? "pointer"
                        : "not-allowed",
                    }}
                  >
                    Block
                  </button>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("SKIPPED");
                      // Same reasoning as the Pass button above -- keeps a subsequent
                      // note-only Ctrl+Enter correct when this is the last case (no advance).
                      pendingVerdictRef.current = "SKIPPED";
                      if (nextVisibleCaseIndex !== undefined)
                        setSelectedIndex(nextVisibleCaseIndex);
                    }}
                    style={{
                      backgroundColor: hasExecuteRunPermission
                        ? "#4b5563"
                        : "#374151",
                      color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: "4px",
                      fontWeight: 600,
                      fontSize: "13px",
                      cursor: hasExecuteRunPermission
                        ? "pointer"
                        : "not-allowed",
                    }}
                  >
                    Skip
                  </button>
                </div>

                {/* DOCKED HOTKEY STATUS BADGE */}
                <FocusIndicatorBadge
                  status={fsm.hotkeyStatus}
                  currentZone={fsm.currentZone}
                  onToggleHotkeys={fsm.toggleHotkeys}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* FOOTER BAR */}
      <footer
        style={{
          height: "24px",
          backgroundColor: "#090d16",
          borderTop: "1px solid #1f2937",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          fontSize: "11px",
          color: "#6b7280",
        }}
      >
        <div>
          Keyboard Nav: <strong style={{ color: "#9ca3af" }}>j</strong> (down) |{" "}
          <strong style={{ color: "#9ca3af" }}>k</strong> (up) |{" "}
          <strong style={{ color: "#9ca3af" }}>p</strong> (pass) |{" "}
          <strong style={{ color: "#9ca3af" }}>f</strong> (fail) |{" "}
          <strong style={{ color: "#9ca3af" }}>b</strong> (block) |{" "}
          <strong style={{ color: "#9ca3af" }}>s</strong> (skip) |{" "}
          <strong style={{ color: "#9ca3af" }}>Ctrl+Enter</strong> (submit)
        </div>
        <div>
          Status: <strong style={{ color: "#10b981" }}>{syncStatus}</strong>
        </div>
      </footer>
    </div>
  );
}
