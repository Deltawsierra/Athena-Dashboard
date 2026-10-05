import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import GlassCard from "@/components/GlassCard";
import Failsafe from "@/pages/Failsafe";
import { changePassword } from "@/utils/auth";
import { apiFetch } from "@/lib/queryClient";
import type { PublicUser } from "@shared/schema";

/** The shortest password the server takes (server/password.ts MIN_PASSWORD_LENGTH). */
const MIN_PASSWORD_LENGTH = 12;

interface ChangePasswordProps {
  user: PublicUser;
  admin: boolean;
  onChanged: (user: PublicUser) => void;
  onLogout: () => void;
}

/**
 * Shown before anything else to an account that must set a new password (the
 * first-run admin, or an account found on a legacy default). The server
 * refuses such an account everything but this, signing out, reading itself
 * and every stop -- so the kill switch is on this screen too, for an admin:
 * engaging it sends a stop to every running scan and retest, and nothing here
 * waits on the password being changed first. So is the failsafe console: an
 * admin may be the second operator a pause, stand-down or terminate waits on,
 * and signs it here without changing the password first.
 */
export default function ChangePassword({ user, admin, onChanged, onLogout }: ChangePasswordProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("The new password and its confirmation differ.");
      return;
    }
    setSaving(true);
    try {
      onChanged(await changePassword(current, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The password was not changed.");
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden athena-horizon">
      <div className="w-full max-w-md relative z-10 space-y-4">
        <GlassCard>
          <h1 className="text-2xl font-bold mb-2">Set a new password</h1>
          <p className="text-sm text-muted-foreground mb-6" data-testid="text-change-password-reason">
            The account <strong>{user.username}</strong> must set a new password before anything else. Its
            current password was set at installation, or is a default an earlier release shipped with.
          </p>
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
                data-testid="text-change-password-error"
              >
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
                data-testid="input-current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password (at least {MIN_PASSWORD_LENGTH} characters)</Label>
              <Input
                id="new-password"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                required
                data-testid="input-new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm the new password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                data-testid="input-confirm-password"
              />
            </div>
            <div className="flex gap-3">
              <Button type="submit" className="flex-1" disabled={saving} data-testid="button-change-password">
                {saving ? "Saving..." : "Set new password"}
              </Button>
              <Button type="button" variant="outline" onClick={onLogout} data-testid="button-change-password-logout">
                Sign out
              </Button>
            </div>
          </form>
        </GlassCard>
        {admin && <KillSwitch />}
        {admin && (
          <GlassCard>
            <h2 className="text-lg font-semibold mb-2">Failsafe console</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Draft or sign a pause, stand-down or terminate, or withdraw a resume or release. It works now, before
              the password is changed; the rest of the console waits for it.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setConsoleOpen((open) => !open)}
              data-testid="button-change-password-failsafe"
            >
              {consoleOpen ? "Close the failsafe console" : "Open the failsafe console"}
            </Button>
          </GlassCard>
        )}
      </div>
      {admin && consoleOpen && (
        <div className="w-full max-w-6xl relative z-10 mt-4" data-testid="change-password-failsafe-console">
          <Failsafe />
        </div>
      )}
    </div>
  );
}

/** What the server said a press of the switch came to: engaged or not, and its sentence. */
interface Pressed {
  engaged: boolean;
  said: string;
}

/**
 * The AI kill switch, as on the AI Control page: one press engages it, and the
 * server sends a stop to every running scan and retest. Only the switch is
 * sent. The screen says engaged only when the server's answer says so.
 */
function KillSwitch() {
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [sending, setSending] = useState(false);

  const engage = async () => {
    setSending(true);
    try {
      const response = await apiFetch("PATCH", "/api/ai-control", { killSwitchEnabled: true });
      const body = (await response.json().catch(() => null)) as
        { killSwitchEnabled?: unknown; engaged?: unknown; message?: unknown; stops?: { sent?: unknown; accepted?: unknown } } | null;
      const engaged = body?.engaged === true || (response.ok && body?.killSwitchEnabled === true);
      const stops = body?.stops && typeof body.stops.sent === "number" && typeof body.stops.accepted === "number"
        ? ` Scan stops sent: ${body.stops.sent}; accepted by the engine: ${body.stops.accepted}.`
        : "";
      const message = typeof body?.message === "string" ? ` ${body.message}` : "";
      setPressed(engaged
        ? { engaged: true, said: `The kill switch is engaged.${stops}${message}` }
        : { engaged: false, said: `The kill switch was not engaged (status ${response.status}).${message} Press it again.` });
    } catch (err) {
      setPressed({
        engaged: false,
        said: `No answer arrived, so whether the kill switch is engaged is not known: ${
          err instanceof Error ? err.message : String(err)}. Press it again.`,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <GlassCard>
      <h2 className="text-lg font-semibold mb-2">AI kill switch</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Stops every running scan and retest. It works now, before the password is changed.
      </p>
      {/* Never disabled while a press is out: pressing it twice sends the stops twice, which is harmless. */}
      <Button variant="destructive" className="w-full" onClick={() => void engage()} data-testid="button-change-password-kill-switch">
        {sending ? "Engaging..." : "Engage kill switch"}
      </Button>
      {pressed && (
        <p
          role="status"
          className={pressed.engaged ? "text-sm mt-3" : "text-sm mt-3 text-destructive"}
          data-testid="text-change-password-kill-switch"
        >
          {pressed.said}
        </p>
      )}
    </GlassCard>
  );
}
