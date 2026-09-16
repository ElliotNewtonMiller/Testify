import React, { useState, useEffect, useCallback, useRef } from "react";
import { useFocusFSM, FocusZone } from "./hooks/useFocusFSM";
import { useHotkeyEngine, VerdictType } from "./hooks/useHotkeyEngine";
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
import { LoginPage } from "./components/LoginPage";
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

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [failureNotes, setFailureNotes] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("Connected");
  const [dbVerification, setDbVerification] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showStepDrawer, setShowStepDrawer] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Specification / Execution mode toggle (Pane 1 header) & Specification-mode state
  const [workspaceMode, setWorkspaceMode] = useState<"EXECUTION" | "SPECIFICATION">(
    "EXECUTION",
  );
  const [specData, setSpecData] = useState<SpecTreeData | null>(null);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const [specSelectedCaseId, setSpecSelectedCaseId] = useState<string | null>(
    null,
  );
  const [specCaseDetail, setSpecCaseDetail] = useState<SpecCaseDetail | null>(
    null,
  );
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);

  // Authentication & RBAC User State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState<boolean>(false);
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

  const [runsList, setRunsList] = useState<EntityItem[]>([
    { id: "bld_01", name: "Run 2026.09.09-RC1", status: "OPEN" },
    { id: "bld_02", name: "Nightly Run #142", status: "IN_PROGRESS" },
    { id: "bld_03", name: "Sprint 44 Final Run", status: "CLOSED" },
  ]);
  const [selectedRunId, setSelectedRunId] = useState<string>("bld_01");

  // Entity Modal State
  const [entityModalOpen, setEntityModalOpen] = useState<boolean>(false);
  const [modalEntityType, setModalEntityType] = useState<EntityType>("PROJECT");
  const [modalActionType, setModalActionType] = useState<ActionType>("CREATE");
  const [modalSelectedItem, setModalSelectedItem] = useState<EntityItem | null>(
    null,
  );

  const notesInputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Guard against out-of-order fetch responses: selectedProjectId/selectedPlanId go through
  // a fake-seed -> real-id bootstrap sequence (see loadProjects/loadPlans), which can fire
  // several requests in quick succession. Without this, a slower, now-stale response (e.g.
  // for the fake seed id) can resolve after a newer one and silently overwrite fresh data.
  const specTreeRequestSeq = useRef(0);
  const executionWorkspaceRequestSeq = useRef(0);

  // Display Toast Notification (moved above the entity/spec handlers below, which reference it)
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  }, []);

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
      if (actionType === "CREATE") {
        setPlansList((prev) => [...prev, item]);
        setSelectedPlanId(item.id);
        setWorkspace((prev) =>
          prev
            ? {
                ...prev,
                plan: {
                  id: item.id,
                  name: item.name,
                  status: item.status || "ACTIVE",
                },
              }
            : prev,
        );
        showToast(`Created New Test Plan: ${item.name}`);
      } else if (actionType === "EDIT") {
        setPlansList((prev) => prev.map((p) => (p.id === item.id ? item : p)));
        setWorkspace((prev) =>
          prev && prev.plan.id === item.id
            ? {
                ...prev,
                plan: {
                  ...prev.plan,
                  name: item.name,
                  status: item.status || prev.plan.status,
                },
              }
            : prev,
        );
        showToast(`Updated Test Plan: ${item.name}`);
      } else if (actionType === "DELETE") {
        const updated = plansList.filter((p) => p.id !== item.id);
        setPlansList(updated);
        if (selectedPlanId === item.id && updated.length > 0) {
          setSelectedPlanId(updated[0].id);
          setWorkspace((prev) =>
            prev
              ? {
                  ...prev,
                  plan: {
                    id: updated[0].id,
                    name: updated[0].name,
                    status: updated[0].status || "ACTIVE",
                  },
                }
              : prev,
          );
        }
        showToast(`Deleted Test Plan: ${item.name}`);
      }
    } else if (entityType === "RUN") {
      if (actionType === "CREATE") {
        setRunsList((prev) => [...prev, item]);
        setSelectedRunId(item.id);
        setWorkspace((prev) =>
          prev
            ? {
                ...prev,
                build: {
                  id: item.id,
                  name: item.name,
                  status: item.status || "OPEN",
                },
              }
            : prev,
        );
        showToast(`Created New Test Run: ${item.name}`);
      } else if (actionType === "EDIT") {
        setRunsList((prev) => prev.map((r) => (r.id === item.id ? item : r)));
        setWorkspace((prev) =>
          prev && prev.build.id === item.id
            ? {
                ...prev,
                build: {
                  ...prev.build,
                  name: item.name,
                  status: item.status || prev.build.status,
                },
              }
            : prev,
        );
        showToast(`Updated Test Run: ${item.name}`);
      } else if (actionType === "DELETE") {
        const updated = runsList.filter((r) => r.id !== item.id);
        setRunsList(updated);
        if (selectedRunId === item.id && updated.length > 0) {
          setSelectedRunId(updated[0].id);
          setWorkspace((prev) =>
            prev
              ? {
                  ...prev,
                  build: {
                    id: updated[0].id,
                    name: updated[0].name,
                    status: updated[0].status || "OPEN",
                  },
                }
              : prev,
          );
        }
        showToast(`Deleted Test Run: ${item.name}`);
      }
    }
  };

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
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/plans`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.plans && data.plans.length > 0) {
          const mapped: EntityItem[] = data.plans.map((p: any) => ({
            id: p.id,
            name: p.name,
            status: p.status,
          }));
          setPlansList(mapped);
          setSelectedPlanId((prev) =>
            mapped.some((p) => p.id === prev) ? prev : mapped[0].id,
          );
        }
      }
    } catch {
      // Network error -- keep the existing (fallback) list
    }
  }, []);

  // Execution-mode workspace: parameterized by the selected plan (and optionally build)
  // instead of hardcoded to the seed plan/build like the old /api/v1/workspace endpoint.
  const refreshExecutionWorkspace = useCallback(async () => {
    if (!selectedPlanId) return;
    const seq = ++executionWorkspaceRequestSeq.current;
    try {
      const url = selectedRunId
        ? `/api/v1/test-plans/${selectedPlanId}/cases?build_id=${encodeURIComponent(selectedRunId)}`
        : `/api/v1/test-plans/${selectedPlanId}/cases`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (executionWorkspaceRequestSeq.current !== seq) return; // a newer request already resolved
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
          })),
        });

        if (builds.length > 0) {
          const runItems: EntityItem[] = builds.map((b: any) => ({
            id: b.id,
            name: (b.name || "").replace(/^Build\s+/i, "Run "),
            status: b.status,
          }));
          setRunsList(runItems);
          setSelectedRunId((prev) =>
            runItems.some((r) => r.id === prev) ? prev : runItems[0].id,
          );
        }
        return;
      }
    } catch {
      // API offline fallback
    }
    if (executionWorkspaceRequestSeq.current === seq) {
      setWorkspace(DEFAULT_FALLBACK_WORKSPACE);
    }
  }, [selectedPlanId, selectedProjectId, selectedRunId, projectsList]);

  // Specification-mode data: the whole project's suite/case spec, annotated with the
  // selected plan's inclusion state. Also drives Pane 1's suite tree in BOTH modes (see
  // suiteNodes below), fixing the tree's pre-existing flat/fake-count display.
  const refreshSpecTree = useCallback(async () => {
    if (!selectedProjectId || !selectedPlanId) return;
    const seq = ++specTreeRequestSeq.current;
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/spec-tree?plan_id=${selectedPlanId}`,
        { headers: authHeaders() },
      );
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
      if (!selectedPlanId) return;
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
      if (!selectedPlanId) return;
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

  // Fetch DB verification stats
  const verifyDatabase = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/executions/verify");
      if (res.ok) {
        const data = await res.json();
        setDbVerification(data);
      }
    } catch (err) {
      console.error("Failed to verify DB:", err);
    }
  }, []);

  useEffect(() => {
    fetchCurrentUser();
    verifyDatabase();
  }, [fetchCurrentUser, verifyDatabase]);

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
  // drives Pane 1's suite tree in Execution mode -- see suiteNodes below); Execution mode
  // additionally needs the plan's execution queue.
  useEffect(() => {
    if (!currentUser || !selectedProjectId || !selectedPlanId) return;
    refreshSpecTree();
    if (workspaceMode === "EXECUTION") {
      refreshExecutionWorkspace();
    }
  }, [
    currentUser,
    workspaceMode,
    selectedProjectId,
    selectedPlanId,
    refreshSpecTree,
    refreshExecutionWorkspace,
  ]);

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

  // Execute verdict submission (Optimistic UI + Background API)
  const submitVerdict = useCallback(
    async (
      verdict: VerdictType,
      notes?: string,
      targetCaseOverride?: TestCase,
    ) => {
      const targetCase = targetCaseOverride || activeCase;
      if (!targetCase || !workspace) return;

      // 1. OPTIMISTIC UI UPDATE (<10ms)
      setWorkspace((prev) => {
        if (!prev) return prev;
        const updatedCases = prev.cases.map((c) =>
          c.plan_case_id === targetCase.plan_case_id
            ? { ...c, latest_verdict: verdict }
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
            notes:
              notes ||
              (verdict === "FAILED" || verdict === "BLOCKED"
                ? failureNotes
                : null),
            execution_duration_ms: Math.floor(Math.random() * 800) + 200,
          }),
        });

        if (response.ok) {
          setSyncStatus(
            `Connected (Recorded ${targetCase.external_id} -> ${verdict})`,
          );
          verifyDatabase();
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
    [activeCase, workspace, failureNotes, verifyDatabase],
  );

  // Cases visible in Pane 2 for Specification mode: the whole project, or just the
  // currently selected suite's direct cases if one is selected in the tree.
  const specCasesForSuite: SpecCaseGridItem[] = specData
    ? specData.cases.filter((c) => !selectedSuiteId || c.test_suite_id === selectedSuiteId)
    : [];

  // Global Hotkey Engine Hook wiring. j/k/[/]//  stay valid in both modes; p/f/b/s
  // (verdict recording) are disabled in Specification mode -- see useHotkeyEngine's
  // `mode` option.
  useHotkeyEngine({
    fsm,
    mode: workspaceMode,
    caseCount:
      workspaceMode === "SPECIFICATION"
        ? specCasesForSuite.length
        : workspace?.cases.length || 0,
    selectedIndex:
      workspaceMode === "SPECIFICATION"
        ? specCasesForSuite.findIndex((c) => c.id === specSelectedCaseId)
        : selectedIndex,
    onSelectIndex: (idx) => {
      if (workspaceMode === "SPECIFICATION") {
        const target = specCasesForSuite[idx];
        if (target) setSpecSelectedCaseId(target.id);
      } else {
        setSelectedIndex(idx);
      }
    },
    onVerdict: (verdict) => {
      submitVerdict(verdict);
      if (verdict === "FAILED" || verdict === "BLOCKED") {
        setTimeout(() => {
          if (notesInputRef.current) notesInputRef.current.focus();
        }, 50);
      }
    },
    onSubmitNotes: (notesText) => {
      submitVerdict("FAILED", notesText);
      setFailureNotes("");
      if (workspace && selectedIndex < workspace.cases.length - 1) {
        setSelectedIndex((idx) => idx + 1);
      }
    },
    onToggleStepDrawer: () => setShowStepDrawer((prev) => !prev),
    onToggleSuiteExpand: () => {
      showToast("Toggled suite folder tree state ([ / ])");
    },
    onFocusSearch: () => {
      if (searchInputRef.current) searchInputRef.current.focus();
    },
    onPermissionDeniedToast: (msg) => showToast(`🔒 ${msg}`),
    notesInputRef,
  });

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
          verifyDatabase();
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

  const suiteNodes: SuiteTreeNode[] = specData ? buildSuiteNodes(specData.suites) : [];

  const hasExecuteRunPermission = userPermissions.includes("EXECUTE_RUN");
  const hasUserManagePermission =
    userPermissions.includes("USER_MANAGE") ||
    userPermissions.includes("SYSTEM_ADMIN");
  const hasPlanManagePermission =
    userPermissions.includes("PLAN_MANAGE") ||
    userPermissions.includes("SYSTEM_ADMIN");

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
        projects={[workspace.project]}
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
              onClick={() => openEntityModal("PLAN", "DELETE")}
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
              onClick={() => openEntityModal("RUN", "CREATE")}
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
              onClick={() => openEntityModal("RUN", "DELETE")}
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

      {/* 3-PANE TOPOLOGY WORKSPACE */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* PANE 1: RECURSIVE TREE NAVIGATION (28px NODE DENSITY) */}
        <div
          style={{
            width: "280px",
            backgroundColor: "#0d111c",
            borderRight: "1px solid #1f2937",
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

          <VirtualizedSuiteTree
            suites={suiteNodes}
            selectedSuiteId={selectedSuiteId}
            onSelectSuite={(suiteId) => {
              setSelectedSuiteId((prev) => (prev === suiteId ? null : suiteId));
              if (workspaceMode === "SPECIFICATION") setSpecSelectedCaseId(null);
            }}
            mode={workspaceMode}
            canManagePlan={hasPlanManagePermission}
            onToggleSuiteInclusion={handleToggleSuiteInclusion}
          />

          {/* DB STATS LOG */}
          <div
            style={{
              marginTop: "auto",
              padding: "12px",
              borderTop: "1px solid #1f2937",
              fontSize: "11px",
              backgroundColor: "#090d16",
            }}
          >
            <div
              style={{ fontWeight: 600, color: "#9ca3af", marginBottom: "4px" }}
            >
              DB VERIFICATION STATS:
            </div>
            <div style={{ color: "#10b981" }}>
              Immutable Executions: {dbVerification?.total_executions || 0}
            </div>
            <div style={{ color: "#60a5fa" }}>
              Audit Logs: {dbVerification?.auditLogs?.length || 0}
            </div>
          </div>
        </div>

        {/* PANE 2: TEST CASE QUEUE GRID (32px ROW DENSITY) */}
        <div
          style={{
            width: "420px",
            backgroundColor: "#111827",
            borderRight: "1px solid #1f2937",
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
              <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                {specCasesForSuite.filter((c) => c.in_plan).length}/{specCasesForSuite.length} in plan
              </span>
            ) : (
              <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                <span style={{ color: "#10b981" }}>{passedCount} Pass</span> |{" "}
                <span style={{ color: "#ef4444" }}>{failedCount} Fail</span>
              </span>
            )}
          </div>

          {workspaceMode === "SPECIFICATION" ? (
            <SpecCaseListGrid
              cases={specCasesForSuite}
              selectedCaseId={specSelectedCaseId}
              onSelectCase={(caseId) => setSpecSelectedCaseId(caseId)}
              filterQuery={searchQuery}
              canManagePlan={hasPlanManagePermission}
              onToggleInclusion={handleToggleCaseInclusion}
              pendingCaseId={pendingToggleId}
            />
          ) : (
            <TestCaseQueueGrid
              cases={workspace.cases}
              selectedIndex={selectedIndex}
              onSelectCase={(idx) => setSelectedIndex(idx)}
              filterQuery={searchQuery}
            />
          )}
        </div>

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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      marginBottom: "8px",
                    }}
                  >
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "#f9fafb" }}>
                      {specActiveCase.external_id}
                    </span>
                    <span style={{ fontSize: "14px", color: "#9ca3af" }}>
                      {specActiveCase.title}
                    </span>
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
                  </div>

                  <button
                    onClick={() =>
                      handleToggleCaseInclusion(specActiveCase.id, !specActiveCase.in_plan)
                    }
                    disabled={
                      pendingToggleId === specActiveCase.id ||
                      !hasPlanManagePermission ||
                      (!specActiveCase.in_plan && !specActiveCase.linkable)
                    }
                    title={
                      !hasPlanManagePermission
                        ? "Requires plan management permission"
                        : !specActiveCase.in_plan && !specActiveCase.linkable
                          ? "Latest version is not Approved -- this project does not allow linking draft versions to a plan"
                          : specActiveCase.in_plan
                            ? "Remove from plan"
                            : "Add to plan"
                    }
                    style={{
                      flexShrink: 0,
                      padding: "6px 14px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: 700,
                      border: specActiveCase.in_plan
                        ? "1px solid #22c55e"
                        : "1px solid #334155",
                      backgroundColor: specActiveCase.in_plan
                        ? "rgba(34, 197, 94, 0.15)"
                        : "transparent",
                      color: specActiveCase.in_plan ? "#4ade80" : "#9ca3af",
                      cursor:
                        pendingToggleId === specActiveCase.id ||
                        !hasPlanManagePermission ||
                        (!specActiveCase.in_plan && !specActiveCase.linkable)
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {pendingToggleId === specActiveCase.id
                      ? "…"
                      : specActiveCase.in_plan
                        ? "✓ In Plan"
                        : "+ Add to Plan"}
                  </button>
                </div>

                {/* CASE DETAILS (READ-ONLY -- CURATION ONLY, NO EDITING IN THIS VIEW) */}
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
                      {specVersionDetail?.preconditions || "—"}
                    </div>
                  </div>

                  {specVersionDetail?.summary && (
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
                      <div style={{ fontSize: "12px", color: "#d1d5db" }}>
                        {specVersionDetail.summary}
                      </div>
                    </div>
                  )}

                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "#6b7280",
                      textTransform: "uppercase",
                      marginBottom: "8px",
                    }}
                  >
                    Ordered Step Specification (read-only)
                  </div>

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
                  {!specVersionDetail && (
                    <div style={{ marginTop: "12px", color: "#6b7280", fontSize: "12px" }}>
                      Loading step detail…
                    </div>
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
                Select a test case to view its specification.
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
                    Actual Result / Execution Failure Notes (Zone 4 - Typing
                    Protection Mode)
                  </label>
                  <textarea
                    ref={notesInputRef}
                    value={failureNotes}
                    onChange={(e) => setFailureNotes(e.target.value)}
                    onFocus={() => fsm.setZone("TEXT_INPUT")}
                    onBlur={() => fsm.setZone("EXECUTION_CONTAINER")}
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
                      if (selectedIndex < workspace.cases.length - 1)
                        setSelectedIndex((i) => i + 1);
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
                    [P] Pass
                  </button>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("FAILED");
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
                    [F] Fail
                  </button>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("BLOCKED");
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
                    [B] Block
                  </button>
                  <button
                    onClick={() => {
                      if (!fsm.canExecute)
                        return showToast(
                          "Permission Denied: EXECUTE_RUN required",
                        );
                      submitVerdict("SKIPPED");
                      if (selectedIndex < workspace.cases.length - 1)
                        setSelectedIndex((i) => i + 1);
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
                    [S] Skip
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
