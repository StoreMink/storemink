import { redirect } from "next/navigation";

// The old address that compared two versions (`?from=<a>&to=<b>`). What
// changed is now the theme page's Changes tab (wave TS-2, contract section
// 6.6), which compares the design shown with the design it was made from,
// so `to` becomes the design shown and `from` is dropped. The theme page
// applies its own superadmin gate and falls back to the current design.
export default async function ThemeStudioComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const raw = Array.isArray(query.to) ? query.to[0] : query.to;
  const to = typeof raw === "string" && raw ? raw : null;
  redirect(
    `/dashboard/themes/studio/${encodeURIComponent(projectId)}?tab=changes${to ? `&version=${encodeURIComponent(to)}` : ""}`,
  );
}
