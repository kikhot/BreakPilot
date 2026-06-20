package bridge

data class BridgeMessage(
    val id: String? = null,
    val type: String,
    val clientId: String? = null,
    val sessionId: String? = null,
    val ideSessionId: String? = null,
    val workspaceRoot: String? = null,
    val requestId: String? = null,
    val confirmationId: String? = null,
    val action: String? = null,
    val actionKind: String? = null,
    val riskLevel: String? = null,
    val title: String? = null,
    val expressionPreview: String? = null,
    val sessionName: String? = null,
    val runConfigName: String? = null,
    val filePath: String? = null,
    val file: String? = null,
    val line: Int? = null,
    val rememberScopes: List<String> = emptyList(),
    val rememberScope: String? = null,
    val command: String? = null,
    val expression: String? = null,
    val ide: String? = null,
    val name: String? = null,
    val language: String? = null,
    val state: String? = null,
    val active: Boolean? = null,
    val threadId: Int? = null,
    val frameId: Int? = null,
    val reason: String? = null,
    val description: String? = null,
    val breakpointId: String? = null,
    val breakpoint: AgentBreakpoint? = null,
    val capabilities: Map<String, Any?> = emptyMap(),
    val options: Map<String, Any?> = emptyMap(),
    val snapshot: Map<String, Any?> = emptyMap(),
    val result: Map<String, Any?> = emptyMap(),
    val error: Map<String, Any?> = emptyMap(),
    val stopped: Map<String, Any?> = emptyMap(),
    val topFrame: Map<String, Any?> = emptyMap(),
    val timestamp: String? = null,
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
    const val BridgeWelcome = "bridge_welcome"
    const val BridgeRejected = "bridge_rejected"
    const val BridgeDisconnected = "bridge_disconnected"
    const val IdeRegister = "ide_register"
    const val IdeHeartbeat = "ide_heartbeat"
    const val IdeSessionStarted = "ide_session_started"
    const val IdeSessionPaused = "ide_session_paused"
    const val IdeSessionResumed = "ide_session_resumed"
    const val IdeSessionTerminated = "ide_session_terminated"
    const val IdeBreakpointAdded = "ide_breakpoint_added"
    const val IdeBreakpointRemoved = "ide_breakpoint_removed"
    const val IdeBreakpointHit = "ide_breakpoint_hit"
    const val IdeStackSnapshot = "ide_stack_snapshot"
    const val IdeVariablesSnapshot = "ide_variables_snapshot"
    const val IdeCommandResult = "ide_command_result"
    const val AgentSetBreakpoint = "agent_set_breakpoint"
    const val AgentRemoveBreakpoint = "agent_remove_breakpoint"
    const val AgentClearBreakpoints = "agent_clear_breakpoints"
    const val AgentRequestVariables = "agent_request_variables"
    const val AgentStartDebug = "agent_start_debug"
    const val AgentContinue = "agent_continue"
    const val AgentPause = "agent_pause"
    const val AgentStepOver = "agent_step_over"
    const val AgentStepInto = "agent_step_into"
    const val AgentStepOut = "agent_step_out"
    const val AgentEvaluate = "agent_evaluate"
    const val AgentStopDebug = "agent_stop_debug"
    const val UserConfirmContinue = "user_confirm_continue"
    const val UserRejectContinue = "user_reject_continue"
}
