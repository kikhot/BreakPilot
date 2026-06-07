package bridge

data class BridgeMessage(
    val id: String? = null,
    val type: String,
    val sessionId: String? = null,
    val workspaceRoot: String? = null,
    val breakpointId: String? = null,
    val breakpoint: AgentBreakpoint? = null,
    val payload: Map<String, Any?> = emptyMap()
)

data class AgentBreakpoint(
    val id: String,
    val file: String,
    val line: Int,
    val column: Int? = null,
    val condition: String? = null,
    val owner: String = "agent",
    val verified: Boolean = false
)

object MessageTypes {
    const val IdeRegister = "ide_register"
    const val IdeHeartbeat = "ide_heartbeat"
    const val IdeBreakpointAdded = "ide_breakpoint_added"
    const val IdeBreakpointRemoved = "ide_breakpoint_removed"
    const val IdeVariablesSnapshot = "ide_variables_snapshot"
    const val AgentSetBreakpoint = "agent_set_breakpoint"
    const val AgentRemoveBreakpoint = "agent_remove_breakpoint"
    const val AgentContinue = "agent_continue"
    const val UserConfirmContinue = "user_confirm_continue"
    const val UserRejectContinue = "user_reject_continue"
}
