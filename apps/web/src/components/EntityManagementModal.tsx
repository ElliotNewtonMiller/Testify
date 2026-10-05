import React, { useState, useEffect } from "react";

export type EntityType = "PROJECT" | "PLAN" | "RUN";
export type ActionType = "CREATE" | "EDIT" | "DELETE";

export interface EntityItem {
  id: string;
  name: string;
  prefix?: string;
  status?: string;
}

interface EntityManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityType: EntityType;
  actionType: ActionType;
  selectedItem: EntityItem | null;
  onSave: (
    entityType: EntityType,
    actionType: ActionType,
    item: EntityItem,
  ) => void;
}

export function EntityManagementModal({
  isOpen,
  onClose,
  entityType,
  actionType,
  selectedItem,
  onSave,
}: EntityManagementModalProps) {
  const [name, setName] = useState<string>("");
  const [extraField, setExtraField] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const entityTitle =
    entityType === "PROJECT"
      ? "Project"
      : entityType === "PLAN"
        ? "Test Plan"
        : "Test Run";
  const extraFieldLabel = entityType === "PROJECT" ? "Prefix" : "Status";

  useEffect(() => {
    if (isOpen) {
      setError(null);
      if (actionType === "EDIT" && selectedItem) {
        setName(selectedItem.name);
        setExtraField(selectedItem.prefix || selectedItem.status || "");
      } else if (actionType === "CREATE") {
        setName("");
        setExtraField(
          entityType === "PROJECT"
            ? ""
            : entityType === "PLAN"
              ? "ACTIVE"
              : "OPEN",
        );
      }
    }
  }, [isOpen, actionType, selectedItem, entityType]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (actionType !== "DELETE" && !name.trim()) {
      setError(`${entityTitle} Name is required.`);
      return;
    }
    // Same rule the server enforces: the prefix starts every case's ID (e.g. SHOP-1).
    if (entityType === "PROJECT" && actionType !== "DELETE" && !/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(extraField.trim())) {
      setError("Prefix is required: a letter followed by letters or digits, at most 10 characters (e.g. SHOP).");
      return;
    }

    const newItem: EntityItem = {
      id:
        selectedItem && actionType !== "CREATE"
          ? selectedItem.id
          : `${entityType.toLowerCase()}_${Date.now()}`,
      name: name.trim() || selectedItem?.name || `New ${entityTitle}`,
      ...(entityType === "PROJECT"
        ? { prefix: extraField.trim().toUpperCase() }
        : { status: extraField.trim().toUpperCase() || "ACTIVE" }),
    };

    onSave(entityType, actionType, newItem);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: "420px",
          backgroundColor: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: "10px",
          padding: "24px",
          color: "#f8fafc",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "18px",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: "16px",
              fontWeight: 700,
              color: actionType === "DELETE" ? "#f87171" : "#38bdf8",
            }}
          >
            {actionType === "CREATE"
              ? `Create New ${entityTitle}`
              : actionType === "EDIT"
                ? `Edit ${entityTitle}`
                : `Delete ${entityTitle}`}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              fontSize: "18px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              backgroundColor: "rgba(239, 68, 68, 0.15)",
              border: "1px solid #ef4444",
              color: "#fca5a5",
              padding: "8px 12px",
              borderRadius: "6px",
              fontSize: "12px",
              marginBottom: "16px",
            }}
          >
            ⚠️ {error}
          </div>
        )}

        {actionType === "DELETE" ? (
          <div>
            <p
              style={{
                fontSize: "13px",
                color: "#cbd5e1",
                lineHeight: "1.5",
                marginBottom: "20px",
              }}
            >
              Are you sure you want to delete the {entityTitle}{" "}
              <strong style={{ color: "#f8fafc" }}>
                "{selectedItem?.name}"
              </strong>
              ? This action will remove all associated configurations and cannot
              be undone.
            </p>

            <div
              style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "8px 14px",
                  backgroundColor: "#334155",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                style={{
                  padding: "8px 14px",
                  backgroundColor: "#dc2626",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: "14px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "#cbd5e1",
                  marginBottom: "4px",
                  fontWeight: 600,
                }}
              >
                {entityTitle} Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Enter ${entityTitle.toLowerCase()} name...`}
                required
                autoFocus
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #475569",
                  borderRadius: "6px",
                  color: "#f8fafc",
                  fontSize: "13px",
                  boxSizing: "border-box",
                  outline: "none",
                }}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "#cbd5e1",
                  marginBottom: "4px",
                  fontWeight: 600,
                }}
              >
                {extraFieldLabel}
              </label>
              {entityType === "PROJECT" ? (
                <input
                  type="text"
                  value={extraField}
                  onChange={(e) => setExtraField(e.target.value)}
                  placeholder="e.g. TLS, SEC, DEMO"
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    borderRadius: "6px",
                    color: "#f8fafc",
                    fontSize: "13px",
                    boxSizing: "border-box",
                    outline: "none",
                  }}
                />
              ) : (
                <select
                  value={extraField}
                  onChange={(e) => setExtraField(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    borderRadius: "6px",
                    color: "#f8fafc",
                    fontSize: "13px",
                    boxSizing: "border-box",
                    outline: "none",
                  }}
                >
                  {entityType === "PLAN" ? (
                    <>
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="LOCKED">LOCKED</option>
                      <option value="ARCHIVED">ARCHIVED</option>
                    </>
                  ) : (
                    <>
                      <option value="OPEN">OPEN</option>
                      <option value="CLOSED">CLOSED</option>
                    </>
                  )}
                </select>
              )}
            </div>

            <div
              style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "8px 14px",
                  backgroundColor: "#334155",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#0284c7",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                {actionType === "CREATE"
                  ? `Create ${entityTitle}`
                  : `Save Changes`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
