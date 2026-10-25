import { redirect } from "next/navigation";

// The old Publish page. Publish now sits in the theme page's header on every
// tab, and the publish history and the catalog record are in its Log tab
// (wave TS-2, contract section 6.6), so this only sends the browser there;
// the theme page applies its own superadmin gate. release-workspace.tsx
// beside this file is the header's release controls.
export default async function ThemeStudioReleasePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/dashboard/themes/studio/${encodeURIComponent(projectId)}?tab=log`);
}
