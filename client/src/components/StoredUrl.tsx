/**
 * A URL stored in the app's own data -- a document's file URL, typed by an
 * operator -- shown by the one rule for URLs this app did not build:
 *
 *   - a file on this app's own origin is saved inside the app, with the
 *     person's session (AppFileLink);
 *   - anything else is never a link: an http(s) URL is text with a copy button,
 *     and any other scheme is inert text, flagged, with nothing to copy
 *     (TargetUrl, httpOnly).
 *
 * No one-click open of an outside URL, from anything the app stores.
 */
import type { ReactNode } from "react";

import AppFileLink from "@/components/AppFileLink";
import TargetUrl from "@/components/TargetUrl";
import { appFilePath, fileNameOf } from "@/lib/appFile";

export default function StoredUrl({
  url, fileName, className, testId, children,
}: {
  url: string;
  /** The name to save the file under when its path ends in none. */
  fileName: string;
  /** The app file's link: its look and its label. */
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const path = appFilePath(url);
  if (path === null) return <TargetUrl value={url} httpOnly />;
  return (
    <AppFileLink path={path} fileName={fileNameOf(path, fileName)} className={className} testId={testId}>
      {children}
    </AppFileLink>
  );
}
