import { Badge, type BadgeVariant } from "./Badge";
import type { RiskTier } from "../lib/types";

// Elite -> success, Strong -> info, Medium -> neutral, High risk ->
// warning, Avoid -> danger — a "great, good, neutral, caution, avoid"
// gradient across Badge's five existing variants, same shared-palette
// approach FreshnessBadge/StatusBadge already use.
const VARIANT: Record<RiskTier, BadgeVariant> = {
  elite: "success",
  strong: "info",
  medium: "neutral",
  high_risk: "warning",
  avoid: "danger"
};

const LABEL: Record<RiskTier, string> = {
  elite: "Elite",
  strong: "Strong",
  medium: "Medium",
  high_risk: "High risk",
  avoid: "Avoid"
};

export function RiskTierBadge({ tier }: { tier: RiskTier }) {
  return <Badge variant={VARIANT[tier]}>{LABEL[tier]}</Badge>;
}
