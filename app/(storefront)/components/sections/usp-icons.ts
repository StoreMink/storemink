import {
  Star,
  BadgeCheck,
  Truck,
  ShieldCheck,
  Leaf,
  Gift,
  Lock,
  RefreshCcw,
  Clock,
  Heart,
  Headphones,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { UspIcon } from "@/lib/homepage/section-types";

// The trust bar's icon catalogue, as components. Icon names are a fixed
// list (USP_ICONS, enforced by validateConfig), so this map is exhaustive
// and merchants can never inject markup. Shared by the trust bar and the
// multi-column section, which offers the same marks per column.
export const USP_ICON_COMPONENTS: Record<UspIcon, LucideIcon> = {
  star: Star,
  "badge-check": BadgeCheck,
  truck: Truck,
  shield: ShieldCheck,
  leaf: Leaf,
  gift: Gift,
  lock: Lock,
  refresh: RefreshCcw,
  clock: Clock,
  heart: Heart,
  headphones: Headphones,
  sparkles: Sparkles,
};
