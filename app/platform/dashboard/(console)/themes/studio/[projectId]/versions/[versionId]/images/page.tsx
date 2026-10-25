import { redirect } from "next/navigation";

// The old address of one design's pictures. The pictures are now the theme
// page's Pictures tab (wave TS-2, contract section 6.6), so this only sends
// the browser there; the theme page applies its own superadmin gate, and a
// version that is not a design of that theme shows its current design. The
// files beside this one are parts of the Pictures tab.
export default async function ThemeStudioSlotImagesPage({
  params,
}: {
  params: Promise<{ projectId: string; versionId: string }>;
}) {
  const { projectId, versionId } = await params;
  redirect(
    `/dashboard/themes/studio/${encodeURIComponent(projectId)}?tab=pictures&version=${encodeURIComponent(versionId)}`,
  );
}
