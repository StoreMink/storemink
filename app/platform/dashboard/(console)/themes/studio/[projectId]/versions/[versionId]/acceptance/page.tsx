import { redirect } from "next/navigation";

// The old address of one design's checks. The checks are now the theme
// page's Checks tab (wave TS-2, contract section 6.6), so this only sends
// the browser there; the theme page applies its own superadmin gate, and a
// version that is not a design of that theme shows its current design.
// acceptance-evidence.tsx and acceptance-runner.tsx beside this file are
// parts of the Checks tab.
export default async function ThemeStudioAcceptancePage({
  params,
}: {
  params: Promise<{ projectId: string; versionId: string }>;
}) {
  const { projectId, versionId } = await params;
  redirect(
    `/dashboard/themes/studio/${encodeURIComponent(projectId)}?tab=checks&version=${encodeURIComponent(versionId)}`,
  );
}
