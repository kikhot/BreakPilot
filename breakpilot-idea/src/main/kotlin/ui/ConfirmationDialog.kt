package ui

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.ui.Messages

fun showBreakpointConfirmation(bridge: BridgeClient, message: BridgeMessage) {
    val action = message.action ?: "debug command"
    val result = Messages.showDialog(
        "AI Debugger requests permission to run: $action",
        "AI Debugger",
        arrayOf("Allow", "Deny"),
        0,
        Messages.getQuestionIcon()
    )
    if (result == 0) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.UserConfirmContinue,
                confirmationId = message.confirmationId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                action = message.action ?: "allow"
            )
        )
    } else {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.UserRejectContinue,
                confirmationId = message.confirmationId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId
            )
        )
    }
}
