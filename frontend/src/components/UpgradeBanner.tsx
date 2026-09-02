"use client"

import { Lock, Mail } from "lucide-react"
import { useEntitlements } from "@/hooks/useEntitlements"
import { FEATURE_MIN_PLAN, type PlanId } from "@/lib/plans"

const PLAN_LABELS: Record<PlanId, string> = {
  community: "Community",
  starter:   "Starter",
  business:  "Business",
  enterprise: "Enterprise",
}

const CONTACT_EMAIL = "hello@stratait.io"

interface UpgradeBannerProps {
  feature: string
  requiredPlan?: PlanId
  description?: string
  className?: string
}

export function UpgradeBanner({ feature, requiredPlan, description, className }: UpgradeBannerProps) {
  const { planId } = useEntitlements()
  const targetPlan: PlanId = requiredPlan ?? FEATURE_MIN_PLAN[feature] ?? "starter"
  const planLabel = PLAN_LABELS[targetPlan]

  return (
    <div className={`rounded-xl border border-primary/20 bg-primary/5 p-6 flex flex-col items-center gap-3 text-center ${className ?? ""}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
        <Lock className="h-5 w-5 text-primary" />
      </div>
      <div>
        <p className="font-semibold text-foreground">
          Available on {planLabel} plan
        </p>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Currently on {PLAN_LABELS[planId] ?? planId} — plans are assigned manually during our pilot.
        </p>
      </div>
      <a
        href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Upgrade to ${planLabel} plan`)}`}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <Mail className="h-4 w-4" />
        Contact us to upgrade
      </a>
    </div>
  )
}
