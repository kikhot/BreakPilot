package security

enum class ConsentDecision {
    Allow,
    Deny,
    Prompt
}

fun classifyRisk(action: String): ConsentDecision {
    if (action.contains("unsafe_evaluate")) return ConsentDecision.Prompt
    if (action.contains("attach_remote")) return ConsentDecision.Prompt
    return ConsentDecision.Allow
}
