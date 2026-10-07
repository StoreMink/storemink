import { redirect } from "next/navigation";

// Card colours are retired: every product card style now paints its own
// background, so a per-product shade had no visible effect. The page kept
// only to send an old bookmark somewhere useful. The `colors` permission key
// stays (hiddenInNav) so saved roles are not silently rewritten, and the
// stored products.card_color values are left untouched.
export default function ColorsPage() {
  redirect("/dashboard/products");
}
