import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { AccountSettingsView } from "./account-settings-view";

type Tab = "profile" | "security";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; focus?: string }>;
}) {
  const { tab, focus } = await searchParams;

  const user = await getServerUser();
  if (!user) redirect("/auth/login");

  const rows = await withService((db) =>
    db
      .select({
        first_name: admins.firstName,
        last_name: admins.lastName,
        role: admins.role,
        email: admins.email,
        phone: admins.phone,
        phone_verified_at: admins.phoneVerifiedAt,
      })
      .from(admins)
      .where(eq(admins.id, user.id))
      .limit(1),
  ).catch(() => []);
  const profile = rows[0];

  // `focus=phone` lives on the Security tab, so it opens that tab by itself.
  const initialTab: Tab =
    tab === "security" || focus === "phone" || focus === "password"
      ? "security"
      : "profile";

  return (
    <AccountSettingsView
      email={profile?.email ?? user.email ?? ""}
      role={profile?.role ?? ""}
      firstName={profile?.first_name ?? ""}
      lastName={profile?.last_name ?? ""}
      // admins.phone alone proves nothing (invited staff type theirs on the
      // password screen); only phone_verified_at says a code confirmed it.
      phone={profile?.phone ?? ""}
      phoneVerified={!!profile?.phone_verified_at}
      initialTab={initialTab}
      initialFocus={
        focus === "phone" ? "phone" : focus === "password" ? "password" : null
      }
    />
  );
}
