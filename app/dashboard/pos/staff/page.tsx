import { redirect } from "next/navigation";

// There is no separate POS staff screen any more (2026-10-14): cashiers and
// managers are two of the five fixed roles and are invited from Settings →
// Staff like everyone else. Emails, bookmarks and the old sidebar entry still
// name this path, so it forwards rather than 404s.
export default function PosStaffPage() {
  redirect("/dashboard/admins");
}
