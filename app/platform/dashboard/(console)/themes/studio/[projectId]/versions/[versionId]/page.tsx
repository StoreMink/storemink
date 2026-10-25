import { redirect } from "next/navigation";

// The old address of one design's preview. The preview is now the theme
// page's Preview tab (wave TS-2, contract section 6.6), so this only sends
// the browser there; the theme page applies its own superadmin gate, and a
// version that is not a design of that theme shows its current design.
// preview-frame.tsx beside this file is the Preview tab's frame.
export default async function ThemeStudioVersionPreviewPage({
  params,
}: {
  params: Promise<{ projectId: string; versionId: string }>;
}) {
  const { projectId, versionId } = await params;
  redirect(
    `/dashboard/themes/studio/${encodeURIComponent(projectId)}?tab=preview&version=${encodeURIComponent(versionId)}`,
  );
}
