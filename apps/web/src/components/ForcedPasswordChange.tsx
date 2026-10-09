import React, { useState } from 'react';
import type { UserProfile } from './AuthModal';
import { jsonHeaders } from '../utils/session';

interface ForcedPasswordChangeProps {
  user: UserProfile;
  onChanged: (user: UserProfile) => void;
  onLogout: () => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '6px',
  color: '#f8fafc',
  fontSize: '14px',
  boxSizing: 'border-box',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  color: '#cbd5e1',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

/**
 * Shown instead of the app when the signed-in user must choose a new password (the server
 * refuses everything else until they do) -- e.g. the first admin, whose password was generated
 * and printed in the server log.
 */
export function ForcedPasswordChange({ user, onChanged, onLogout }: ForcedPasswordChangeProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("The two passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/v1/auth/credentials', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ newPassword, currentPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) {
        setError(String(data.error || 'Could not change the password.').replace(/^PASSWORD_POLICY_VIOLATION:\s*/, ''));
        return;
      }
      onChanged(data.user);
    } catch {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        width: '100vw',
        backgroundColor: '#090d16',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        color: '#f8fafc',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: '440px',
          backgroundColor: 'rgba(15, 23, 42, 0.85)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '12px',
          padding: '36px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
        }}
      >
        <h1 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 8px 0', color: '#38bdf8' }}>Choose a new password</h1>
        <p style={{ fontSize: '13px', color: '#94a3b8', lineHeight: 1.5, margin: '0 0 22px 0' }}>
          Signed in as <strong style={{ color: '#e2e8f0' }}>{user.username}</strong>. Your current password was set for you, so
          choose your own before continuing. Use at least 16 characters, or 8–15 with a number, an uppercase letter and a symbol.
        </p>

        <label htmlFor="current-password" style={labelStyle}>Current password</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoFocus
          style={{ ...inputStyle, marginBottom: '16px' }}
        />
        <label htmlFor="new-password" style={labelStyle}>New password</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          style={{ ...inputStyle, marginBottom: '16px' }}
        />
        <label htmlFor="confirm-password" style={labelStyle}>Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          style={{ ...inputStyle, marginBottom: '18px' }}
        />

        {error && (
          <div
            style={{
              padding: '10px 12px',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '6px',
              color: '#fca5a5',
              fontSize: '13px',
              marginBottom: '16px',
              overflowWrap: 'anywhere',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          style={{
            width: '100%',
            padding: '11px',
            backgroundColor: '#2563eb',
            border: 'none',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save and continue'}
        </button>
        <button
          type="button"
          onClick={onLogout}
          style={{
            width: '100%',
            marginTop: '10px',
            padding: '9px',
            backgroundColor: 'transparent',
            border: '1px solid #334155',
            borderRadius: '6px',
            color: '#94a3b8',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
