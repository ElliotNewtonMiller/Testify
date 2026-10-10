import { useCallback, useEffect, useRef, useState } from "react";
import type { UserProfile } from "../components/AuthModal";
import type { ActionType, EntityItem, EntityType } from "../components/EntityManagementModal";
import { authHeaders, jsonHeaders } from "../utils/session";

export interface ScopeOptions {
  currentUser: UserProfile | null;
  showToast: (msg: string) => void;
  handleAuthExpiry: () => void;
  /** Ids to start on (a Reports link opened directly). */
  initial: { projectId?: string | null; planId?: string | null; runId?: string | null };
  /** Called when the user switches project, to clear selections that belonged to the old one. */
  onProjectSwitched: () => void;
}

/**
 * The Project / Plan / Run the app is working in: the three lists and what's selected in
 * each, loading them, creating/editing/deleting them (the header's buttons and the entity
 * modal), and closing/opening the selected run.
 */
export function useScope({ currentUser, showToast, handleAuthExpiry, initial, onProjectSwitched }: ScopeOptions) {
  // Entity Selection State (Project, Plan, Run)
  // Start empty -- the real lists load once authenticated. (These used to start from fake
  // placeholder projects/plans that never existed in the database.)
  const [projectsList, setProjectsList] = useState<EntityItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initial.projectId ?? "");

  const [plansList, setPlansList] = useState<EntityItem[]>([]);
  // Archived plans are hidden from the Plan dropdown unless revealed by its own last entry.
  const [showArchivedPlans, setShowArchivedPlans] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>(initial.planId ?? "");
  const [deleteProjectPrompt, setDeleteProjectPrompt] = useState<{ id: string; name: string; detail: string } | null>(null);

  // Starts empty, like the project and plan lists -- a Run can never exist
  // without a real Test Plan (builds.test_plan_id is NOT NULL), so starting empty and
  // relying on refreshExecutionWorkspace's real per-plan fetch (or the clearing effect
  // below, when there's no plan at all) means the dropdown never shows a run that isn't
  // genuinely tied to the currently selected plan.
  const [runsList, setRunsList] = useState<EntityItem[]>([]);
  const [isTogglingRun, setIsTogglingRun] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>(initial.runId ?? "");

  // Entity Modal State
  const [entityModalOpen, setEntityModalOpen] = useState<boolean>(false);
  const [modalEntityType, setModalEntityType] = useState<EntityType>("PROJECT");
  const [modalActionType, setModalActionType] = useState<ActionType>("CREATE");
  const [modalSelectedItem, setModalSelectedItem] = useState<EntityItem | null>(
    null,
  );

  // Two-step delete confirmation for test plans, same shape as deleteSuitePrompt -- shown by
  // handleDeletePlanClick after a non-force delete comes back 409 (bypasses
  // EntityManagementModal entirely, so this is the only confirmation dialog ever shown).
  const [deletePlanPrompt, setDeletePlanPrompt] = useState<{ id: string; name: string; detail: string } | null>(null);
  // Same shape one level down, for test runs (builds) -- see handleDeleteRunClick.
  const [deleteRunPrompt, setDeleteRunPrompt] = useState<{ id: string; name: string; detail: string } | null>(null);
  // Shown in the same banner slot as deletePlanPrompt/deleteRunPrompt when the "+ Create New
  // Test Run" button is clicked with no plan selected -- a Run can never exist without one.
  const [noPlanSetWarning, setNoPlanSetWarning] = useState(false);

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
      // Real backend calls (POST/PUT /api/v1/projects[/:id], apps/server/src/routes/projects.ts).
      // DELETE bypasses this modal -- see handleDeleteProjectClick below.
      if (actionType === "CREATE") {
        (async () => {
          try {
            const res = await fetch("/api/v1/projects", {
              method: "POST",
              headers: jsonHeaders(),
              body: JSON.stringify({ name: item.name, prefix: item.prefix }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to create project");
            const created = data.project;
            setProjectsList((prev) => [...prev, { id: created.id, name: created.name, prefix: created.prefix }]);
            handleSelectProject(created.id);
            showToast(`Created New Project: ${created.name}`);
          } catch (err: any) {
            showToast(err.message || "Failed to create project");
          }
        })();
      } else if (actionType === "EDIT") {
        (async () => {
          try {
            const res = await fetch(`/api/v1/projects/${item.id}`, {
              method: "PUT",
              headers: jsonHeaders(),
              body: JSON.stringify({ name: item.name, prefix: item.prefix }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to update project");
            const updated = data.project;
            setProjectsList((prev) =>
              prev.map((p) => (p.id === updated.id ? { id: updated.id, name: updated.name, prefix: updated.prefix } : p)),
            );
            showToast(`Updated Project: ${updated.name}`);
          } catch (err: any) {
            showToast(err.message || "Failed to update project");
          }
        })();
      }
    } else if (entityType === "PLAN") {
      // Real backend calls -- see apps/server/src/routes/projects.ts's POST/PUT/DELETE
      // .../plans routes. Like PROJECT above and RUN below, Test Plan create/edit/delete
      // actually persists.
      // DELETE is handled by handleDeletePlanClick below instead of here -- it bypasses this
      // modal entirely (see that function's comment for why).
      if (!selectedProjectId) return;
      if (actionType === "CREATE") {
        (async () => {
          try {
            const res = await fetch(`/api/v1/projects/${selectedProjectId}/plans`, {
              method: "POST",
              headers: jsonHeaders(),
              body: JSON.stringify({ name: item.name, status: item.status || "ACTIVE" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to create test plan");
            const created = data.plan;
            setPlansList((prev) => [...prev, { id: created.id, name: created.name, status: created.status }]);
            setSelectedPlanId(created.id);
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
              headers: jsonHeaders(),
              body: JSON.stringify({ name: item.name, status: item.status }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to update test plan");
            const updatedPlan = data.plan;
            setPlansList((prev) =>
              prev.map((p) => (p.id === updatedPlan.id ? { id: updatedPlan.id, name: updatedPlan.name, status: updatedPlan.status } : p)),
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
              headers: jsonHeaders(),
              body: JSON.stringify({ name: item.name, status: item.status || "OPEN" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to create test run");
            const created = data.build;
            setRunsList((prev) => [...prev, { id: created.id, name: created.name, status: created.status }]);
            setSelectedRunId(created.id);
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
              headers: jsonHeaders(),
              body: JSON.stringify({ name: item.name, status: item.status }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.detail || "Failed to update test run");
            const updatedRun = data.build;
            setRunsList((prev) =>
              prev.map((r) => (r.id === updatedRun.id ? { id: updatedRun.id, name: updatedRun.name, status: updatedRun.status } : r)),
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
  // Project delete: try a plain delete first; a project with content comes back 409 with
  // its counts, shown in the same yellow confirm banner the plan/run deletes use.
  const applyProjectDeletedLocally = (deletedId: string) => {
    const remaining = projectsList.filter((p) => p.id !== deletedId);
    setProjectsList(remaining);
    if (selectedProjectId === deletedId) handleSelectProject(remaining[0]?.id ?? "", { silent: true });
  };

  const handleDeleteProjectClick = useCallback(async () => {
    const project = projectsList.find((p) => p.id === selectedProjectId);
    if (!project) return;
    try {
      const res = await fetch(`/api/v1/projects/${project.id}`, { method: "DELETE", headers: authHeaders() });
      if (res.status === 409) {
        const data = await res.json();
        setDeleteProjectPrompt({ id: project.id, name: project.name, detail: data.detail || "This project still contains content." });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as any);
        throw new Error(data.error || "Failed to delete project");
      }
      applyProjectDeletedLocally(project.id);
      showToast(`Deleted Project: ${project.name}`);
    } catch (err: any) {
      showToast(err.message || "Failed to delete project");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsList, selectedProjectId, showToast]);

  const handleConfirmDeleteProject = useCallback(async () => {
    if (!deleteProjectPrompt) return;
    try {
      const res = await fetch(`/api/v1/projects/${deleteProjectPrompt.id}?force=true`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as any);
        throw new Error(data.error || "Failed to delete project");
      }
      applyProjectDeletedLocally(deleteProjectPrompt.id);
      showToast(`Deleted Project: ${deleteProjectPrompt.name}`);
      setDeleteProjectPrompt(null);
    } catch (err: any) {
      showToast(err.message || "Failed to delete project");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteProjectPrompt, projectsList, selectedProjectId, showToast]);

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

  const handleSelectProject = (projectId: string, opts: { silent?: boolean } = {}) => {
    setSelectedProjectId(projectId);
    // Spec/Execute mode's own selections belong to the old project.
    onProjectSwitched();
    setShowArchivedPlans(false);
    if (opts.silent) return;
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
        // Always apply the real list, even when it's empty (a fresh install has no projects).
        const mapped: EntityItem[] = (data.projects || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          prefix: p.prefix,
        }));
        setProjectsList(mapped);
        setSelectedProjectId((prev) =>
          mapped.some((p) => p.id === prev) ? prev : mapped[0]?.id ?? "",
        );
      }
    } catch {
      // Network error -- keep the existing (fallback) list
    }
  }, []);

  const loadPlans = useCallback(async (projectId: string) => {
    // Switching projects quickly can fire loadPlans several times with no guarantee the
    // responses arrive in order -- without a sequence guard, a slower stale call (for a
    // project no longer selected) can overwrite the current project's plansList.
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
        // Default to the first plan that isn't archived (archived plans are hidden from the
        // dropdown unless asked for), falling back to any plan.
        setSelectedPlanId((prev) =>
          mapped.length === 0
            ? ""
            : mapped.some((p) => p.id === prev)
              ? prev
              : (mapped.find((p) => p.status !== "ARCHIVED") ?? mapped[0]).id,
        );
      } else {
        // A failed plans fetch clears the plan (and, through it, the run) rather than leaving
        // the previous project's plan/run on screen under this project.
        setPlansList([]);
        setSelectedPlanId("");
      }
    } catch {
      if (plansRequestSeq.current !== seq) return;
      setPlansList([]);
      setSelectedPlanId("");
    }
  }, []);
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

  const selectedRun = runsList.find((r) => r.id === selectedRunId) || null;

  // Close Run / Open Run (Execute mode, next to "+ Filter"). RUN_MANAGE-gated, same as
  // every other run edit (PUT .../plans/:planId/builds/:buildId).
  const handleToggleRunClosed = useCallback(async () => {
    if (!selectedProjectId || !selectedPlanId || !selectedRunId || !selectedRun) return;
    const nextStatus = selectedRun.status === "CLOSED" ? "OPEN" : "CLOSED";
    setIsTogglingRun(true);
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/plans/${selectedPlanId}/builds/${selectedRunId}`,
        {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(data.detail || data.error || "Failed to update the run");
      }
      setRunsList((prev) => prev.map((r) => (r.id === selectedRunId ? { ...r, status: nextStatus } : r)));
      showToast(nextStatus === "CLOSED" ? "Run closed." : "Run opened.");
    } catch (err: any) {
      showToast(err.message || "Failed to update the run");
    } finally {
      setIsTogglingRun(false);
    }
  }, [selectedProjectId, selectedPlanId, selectedRunId, selectedRun, showToast, handleAuthExpiry]);

  // Real project list only resolves once authenticated (the endpoint requires a Bearer
  // token) -- (re)load it whenever a session is established, whether from a restored
  // token on mount or a fresh login.
  useEffect(() => {
    // Not until a forced password change is done: the server refuses everything else until then.
    if (currentUser && !currentUser.must_change_password) {
      loadProjects();
    }
  }, [currentUser, loadProjects]);

  // Real plan list for whichever project is currently selected.
  useEffect(() => {
    if (currentUser && selectedProjectId) {
      loadPlans(selectedProjectId);
    } else if (currentUser) {
      // No project (none exist yet, or the selected one was deleted): no plans either.
      plansRequestSeq.current++;
      setPlansList([]);
      setSelectedPlanId("");
    }
  }, [currentUser, selectedProjectId, loadPlans]);

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

  return {
    projectsList,
    selectedProjectId,
    plansList,
    showArchivedPlans,
    setShowArchivedPlans,
    selectedPlanId,
    setSelectedPlanId,
    deleteProjectPrompt,
    setDeleteProjectPrompt,
    runsList,
    setRunsList,
    isTogglingRun,
    selectedRunId,
    setSelectedRunId,
    selectedRun,
    entityModalOpen,
    setEntityModalOpen,
    modalEntityType,
    modalActionType,
    modalSelectedItem,
    deletePlanPrompt,
    setDeletePlanPrompt,
    deleteRunPrompt,
    setDeleteRunPrompt,
    noPlanSetWarning,
    setNoPlanSetWarning,
    runsListRequestSeq,
    openEntityModal,
    handleSaveEntity,
    handleDeleteProjectClick,
    handleConfirmDeleteProject,
    handleDeletePlanClick,
    handleConfirmDeletePlan,
    handleDeleteRunClick,
    handleConfirmDeleteRun,
    handleSelectProject,
    handleSelectPlan,
    handleSelectRun,
    refreshRunsList,
    handleToggleRunClosed,
  };
}

export type Scope = ReturnType<typeof useScope>;
