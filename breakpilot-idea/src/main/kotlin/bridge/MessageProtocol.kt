package bridge

data class BridgeMessage(
    val id: String? = null,
    val type: String,
    val clientId: String? = null,
    val sessionId: String? = null,
    val ideSessionId: String? = null,
    val workspaceRoot: String? = null,
    val requestId: String? = null,
    val originRequestId: String? = null,
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
    val path: List<String> = emptyList(),
    val newValue: String? = null,
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
    val ref: Any? = null,
    val offset: Int? = null,
    val limit: Int? = null,
    val pauseEpoch: Long? = null,
    val expectedPauseEpoch: Long? = null,
    val debuggerProtocolVersion: Int? = null,
    val debuggerFeatures: Map<String, Boolean> = emptyMap(),
    val event: Map<String, Any?> = emptyMap(),
    val reason: String? = null,
    val description: String? = null,
    val breakpointId: String? = null,
    val breakpoint: AgentBreakpoint? = null,
    val removed: Boolean? = null,
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
    val hitCondition: String? = null,
    val logMessage: String? = null,
    val enabled: Boolean = true,
    val temporary: Boolean = false,
    val suspendPolicy: String? = null,
    val isLogMessage: Boolean = false,
    val isLogStack: Boolean = false,
    val owner: String = "agent",
    val verified: Boolean = false
)

object MessageTypes {
    const val BridgeWelcome = "bridge_welcome"
    const val BridgeRejected = "bridge_rejected"
    const val BridgeDisconnected = "bridge_disconnected"
    const val BridgeConnected = "bridge_connected"
    const val IdeRegister = "ide_register"
    const val IdeHeartbeat = "ide_heartbeat"
    const val IdeSessionStarted = "ide_session_started"
    const val IdeSessionPaused = "ide_session_paused"
    const val IdeSessionResumed = "ide_session_resumed"
    const val IdeSessionTerminated = "ide_session_terminated"
    const val IdeBreakpointAdded = "ide_breakpoint_added"
    const val IdeBreakpointRemoved = "ide_breakpoint_removed"
    const val IdeBreakpointHit = "ide_breakpoint_hit"
    const val IdeBreakpointsSnapshot = "ide_breakpoints_snapshot"
    const val IdeRunConfigurationsSnapshot = "ide_run_configurations_snapshot"
    const val IdeStackSnapshot = "ide_stack_snapshot"
    const val IdeVariablesSnapshot = "ide_variables_snapshot"
    const val IdeCommandResult = "ide_command_result"
    const val IdeDebugEvent = "ide_debug_event"
    const val AgentSetBreakpoint = "agent_set_breakpoint"
    const val AgentRemoveBreakpoint = "agent_remove_breakpoint"
    const val AgentClearBreakpoints = "agent_clear_breakpoints"
    const val AgentListBreakpoints = "agent_list_breakpoints"
    const val AgentListRunConfigurations = "agent_list_run_configurations"
    const val AgentRequestStack = "agent_request_stack"
    const val AgentRequestVariables = "agent_request_variables"
    const val AgentStartDebug = "agent_start_debug"
    const val AgentContinue = "agent_continue"
    const val AgentPause = "agent_pause"
    const val AgentStepOver = "agent_step_over"
    const val AgentStepInto = "agent_step_into"
    const val AgentStepOut = "agent_step_out"
    const val AgentRunToLine = "agent_run_to_line"
    const val AgentSetVariable = "agent_set_variable"
    const val AgentEvaluate = "agent_evaluate"
    const val AgentStopDebug = "agent_stop_debug"
    const val UserConfirmContinue = "user_confirm_continue"
    const val UserRejectContinue = "user_reject_continue"
}
