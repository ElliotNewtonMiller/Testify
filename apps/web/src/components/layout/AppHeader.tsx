import type { Dispatch, SetStateAction } from "react";
import { useApp } from "../../app/AppContext";

/** Value of the Plan dropdown's "Show/Hide archived plans" entry -- never a real plan id. */
const TOGGLE_ARCHIVED_PLANS_VALUE = "__toggle_archived_plans__";

interface AppHeaderProps {
  appView: "WORKSPACE" | "REPORTS";
  setAppView: Dispatch<SetStateAction<"WORKSPACE" | "REPORTS">>;
  setImportWizardOpen: (open: boolean) => void;
  setExportModalOpen: (open: boolean) => void;
  setAdminPanelOpen: (open: boolean) => void;
  setAuthModalOpen: (open: boolean) => void;
}

/** The top bar: the Project / Plan / Run pickers with their add/edit/delete buttons, Import,
 *  Export, Reports, the Admin Panel, and the signed-in user. */
export function AppHeader({
  appView,
  setAppView,
  setImportWizardOpen,
  setExportModalOpen,
  setAdminPanelOpen,
  setAuthModalOpen,
}: AppHeaderProps) {
  const { currentUser, handleLogout, can, globalCan, scope } = useApp();
  const {
    projectsList,
    plansList,
    runsList,
    selectedProjectId,
    selectedPlanId,
    selectedRunId,
    handleSelectProject,
    handleSelectPlan,
    handleSelectRun,
    handleDeleteProjectClick,
    handleDeletePlanClick,
    handleDeleteRunClick,
    openEntityModal,
    setNoPlanSetWarning,
    showArchivedPlans,
    setShowArchivedPlans,
  } = scope;
  // Creating a project and the Admin Panel are global; everything else is about the selected project.
  const { hasAdminPanelAccess } = globalCan;
  const {
    hasExportDataPermission,
    hasImportDataPermission,
    hasPlanManagePermission,
    hasProjectCreatePermission,
    hasProjectDeletePermission,
    hasRunManagePermission,
    hasSpecViewPermission,
  } = can;

  return (
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
          {globalCan.hasProjectCreatePermission && (
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
          )}
          {hasProjectCreatePermission && (
            <button
              onClick={() => openEntityModal("PROJECT", "EDIT")}
              disabled={!selectedProjectId}
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
          )}
          {hasProjectDeletePermission && (
            <button
              onClick={handleDeleteProjectClick}
              disabled={!selectedProjectId}
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
          )}
        </div>

        <span style={{ color: "#374151" }}>|</span>

        {/* PLAN SELECT & ACTIONS */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ color: "#9ca3af", fontWeight: 600 }}>Plan:</span>
          <select
            value={selectedPlanId}
            onChange={(e) => {
              // The last entry toggles archived plans; it never becomes the selection.
              if (e.target.value === TOGGLE_ARCHIVED_PLANS_VALUE) {
                setShowArchivedPlans((v) => !v);
                return;
              }
              handleSelectPlan(e.target.value);
            }}
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
            {(() => {
              const current = plansList.filter((p) => p.status !== "ARCHIVED");
              const archived = plansList.filter((p) => p.status === "ARCHIVED");
              // An archived plan that's currently selected always stays visible, so the
              // select never shows a blank value.
              const archivedShown = showArchivedPlans
                ? archived
                : archived.filter((p) => p.id === selectedPlanId);
              return (
                <>
                  {current.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {/* ACTIVE is the normal state, so only LOCKED gets a suffix here. */}
                      {p.status && p.status !== "ACTIVE" ? ` [${p.status}]` : ""}
                    </option>
                  ))}
                  {archivedShown.length > 0 && (
                    <optgroup label="Archived">
                      {archivedShown.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {archived.length > 0 && (
                    <option value={TOGGLE_ARCHIVED_PLANS_VALUE} style={{ color: "#94a3b8", fontStyle: "italic" }}>
                      {showArchivedPlans ? "Hide archived plans" : `Show archived plans (${archived.length})`}
                    </option>
                  )}
                </>
              );
            })()}
          </select>
          {hasPlanManagePermission && (
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
          )}
          {hasPlanManagePermission && (
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
          )}
          {hasPlanManagePermission && (
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
          )}
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
                {r.name}
                {r.status === "CLOSED" ? " [CLOSED]" : ""}
              </option>
            ))}
          </select>
          {hasRunManagePermission && (
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
          )}
          {hasRunManagePermission && (
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
          )}
          {hasRunManagePermission && (
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
          )}
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
            onClick={() => setAppView((v) => (v === "REPORTS" ? "WORKSPACE" : "REPORTS"))}
            title={appView === "REPORTS" ? "Back to Execute / Spec" : "Open Reports"}
            style={{
              backgroundColor: appView === "REPORTS" ? "transparent" : "#0ea5e9",
              color: appView === "REPORTS" ? "#7dd3fc" : "#ffffff",
              border: appView === "REPORTS" ? "1px solid #0ea5e9" : "1px solid transparent",
              padding: "4px 10px",
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {appView === "REPORTS" ? "← Back to workspace" : "📊 Reports"}
          </button>
        )}
        {hasAdminPanelAccess && (
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
  );
}
