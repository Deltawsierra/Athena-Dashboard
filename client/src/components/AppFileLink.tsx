/**
 * A link to a file this app serves, saved inside the app with the person's own
 * session (lib/appFile.ts).
 *
 * The href stays the file's path on this origin, so the link reads as what it
 * is. A click is the app's, though: it never navigates and never opens a window.
 * The desktop app opens none (electron-main.cjs), and the system browser it used
 * to hand these to holds no session. The file is read with the session's cookie
 * and saved; a refusal is said in a toast, in the server's words.
 */
import { useState, type MouseEvent, type ReactNode } from "react";

import { useToast } from "@/hooks/use-toast";
import { saveAppFile } from "@/lib/appFile";
import { errorMessage } from "@/lib/loaded";

export default function AppFileLink({
  path, fileName, className, testId, children,
}: { path: string; fileName: string; className?: string; testId?: string; children: ReactNode }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    // A card or row around it may have a click of its own.
    event.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      await saveAppFile(path, fileName);
    } catch (error) {
      toast({ title: "Could not download the file", description: errorMessage(error), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <a href={path} onClick={save} aria-busy={saving} className={className} data-testid={testId}>
      {children}
    </a>
  );
}
