export type ConsentDecision = "allow" | "deny" | "prompt";

export function classifyRisk(action: string): ConsentDecision {
  if (action.includes("unsafe_evaluate")) return "prompt";
  if (action.includes("attach_remote")) return "prompt";
  return "allow";
}
