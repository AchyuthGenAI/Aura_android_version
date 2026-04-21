export type AutomationPolicyTier = "safe_auto" | "confirm" | "locked";

export interface AutomationPolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  riskScore: number;
  reason: string;
  tags: string[];
}

const HIGH_RISK_PATTERNS: Array<{ tag: string; pattern: RegExp; weight: number }> = [
  { tag: "payment", pattern: /\b(pay|purchase|checkout|buy|transfer|invoice|upi|card)\b/i, weight: 35 },
  { tag: "destructive", pattern: /\b(delete|remove|erase|wipe|factory reset|uninstall|format|close account)\b/i, weight: 40 },
  { tag: "security", pattern: /\b(password|2fa|otp|token|credential|security setting)\b/i, weight: 30 },
  { tag: "system", pattern: /\b(registry|powershell|cmd|terminal|task scheduler|services\.msc|device manager)\b/i, weight: 25 },
  { tag: "bulk", pattern: /\b(all files|entire folder|whole drive|everyone|all users)\b/i, weight: 20 },
];

const MEDIUM_RISK_PATTERNS: Array<{ tag: string; pattern: RegExp; weight: number }> = [
  { tag: "messaging", pattern: /\b(send|reply|post|publish|share|message)\b/i, weight: 15 },
  { tag: "admin", pattern: /\b(admin|administrator|elevated|run as admin)\b/i, weight: 20 },
  { tag: "external", pattern: /\b(download|upload|install|execute|run script)\b/i, weight: 18 },
];

export const evaluateAutomationPolicy = (
  message: string,
  tier: AutomationPolicyTier,
  isBackground: boolean,
): AutomationPolicyDecision => {
  const normalized = message.trim();
  let riskScore = 0;
  const tags: string[] = [];

  for (const entry of HIGH_RISK_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      riskScore += entry.weight;
      tags.push(entry.tag);
    }
  }

  for (const entry of MEDIUM_RISK_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      riskScore += entry.weight;
      tags.push(entry.tag);
    }
  }

  if (isBackground) {
    riskScore += 10;
    tags.push("background");
  }

  const dedupedTags = Array.from(new Set(tags));

  if (tier === "locked") {
    return {
      allowed: false,
      requiresConfirmation: false,
      riskScore,
      reason: "Automation policy is locked. Execution is disabled until policy tier is lowered.",
      tags: dedupedTags,
    };
  }

  if (tier === "confirm") {
    const forceConfirm = isBackground || riskScore >= 10;
    const blocked = isBackground && riskScore >= 35;
    return {
      allowed: !blocked,
      requiresConfirmation: forceConfirm,
      riskScore,
      reason: blocked
        ? "High-risk background automation is blocked by policy tier 'confirm'."
        : forceConfirm
          ? "Policy requires confirmation for this automation request."
          : "Policy allows this request.",
      tags: dedupedTags,
    };
  }

  // safe_auto
  if (riskScore >= 70) {
    return {
      allowed: false,
      requiresConfirmation: false,
      riskScore,
      reason: "Request exceeds safe automation threshold for 'safe_auto' policy tier.",
      tags: dedupedTags,
    };
  }

  return {
    allowed: true,
    requiresConfirmation: riskScore >= 65,
    riskScore,
    reason: riskScore >= 65 ? "Request allowed with confirmation." : "Request allowed.",
    tags: dedupedTags,
  };
};
