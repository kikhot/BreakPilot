package debugger

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XStackFrame
import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueChildrenList
import com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink
import com.intellij.xdebugger.impl.breakpoints.XExpressionImpl
import javax.swing.Icon

class VariableReader(
    private val project: Project,
    private val tracker: IdeSessionTracker
) {
    fun handle(message: BridgeMessage, bridge: BridgeClient) {
        val session = tracker.find(message.ideSessionId)
        if (session == null) {
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeVariablesSnapshot,
                    requestId = message.requestId,
                    sessionId = message.sessionId,
                    ideSessionId = message.ideSessionId,
                    error = mapOf(
                        "code" to "IDE_SESSION_NOT_FOUND",
                        "message" to "IDE debug session was not found."
                    )
                )
            )
            return
        }
        val options = message.options
        currentSnapshot(session, options) { snapshot ->
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeVariablesSnapshot,
                    requestId = message.requestId,
                    sessionId = message.sessionId,
                    ideSessionId = message.ideSessionId,
                    snapshot = snapshot
                )
            )
        }
    }

    fun currentSnapshot(
        session: XDebugSession,
        options: Map<String, Any?> = emptyMap(),
        callback: (Map<String, Any?>) -> Unit
    ) {
        val frame = session.currentStackFrame
        if (frame == null) {
            callback(baseSnapshot(session, emptyList(), emptyMap(), options))
            return
        }
        val maxItems = numberOption(options, "maxItems", 20)
        val maxDepth = numberOption(options, "maxDepth", 1)
        val maxStringLength = numberOption(options, "maxStringLength", 2000)
        readFrameVariables(frame, maxItems, maxDepth, maxStringLength) { variables ->
            callback(baseSnapshot(session, listOf(frameMap(frame)), variables, options))
        }
    }

    fun evaluate(ideSessionId: String?, expression: String, callback: (Map<String, Any?>?, String?) -> Unit) {
        val session = tracker.find(ideSessionId)
        val frame = session?.currentStackFrame
        val evaluator = frame?.evaluator
        if (session == null || frame == null) {
            callback(null, "IDE debug session is not paused on a stack frame.")
            return
        }
        if (evaluator == null) {
            callback(null, "The active IDEA debugger does not expose a generic evaluator.")
            return
        }
        evaluator.evaluate(
            XExpressionImpl.fromText(expression),
            object : XDebuggerEvaluator.XEvaluationCallback {
                override fun evaluated(result: XValue) {
                    readValue("result", result, 10, 1, 2000) { variable ->
                        callback(mapOf("value" to variable), null)
                    }
                }

                override fun errorOccurred(errorMessage: String) {
                    callback(null, errorMessage)
                }
            },
            frame.sourcePosition
        )
    }

    private fun baseSnapshot(
        session: XDebugSession,
        stackFrames: List<Map<String, Any?>>,
        variables: Map<String, Any?>,
        options: Map<String, Any?>
    ): Map<String, Any?> {
        return mapOf(
            "source" to "ide",
            "ide" to "idea",
            "language" to "idea",
            "threadId" to 0,
            "frameId" to (stackFrames.firstOrNull()?.get("id")),
            "profile" to (options["profile"] ?: "focused"),
            "stackFrames" to stackFrames,
            "variables" to mapOf(
                "locals" to mapOf(
                    "name" to "locals",
                    "category" to "locals",
                    "rawScopes" to listOf("IDEA Frame"),
                    "expensive" to false,
                    "variables" to variables
                )
            ),
            "availableCategories" to listOf("locals"),
            "availableScopes" to listOf("IDEA Frame"),
            "limits" to mapOf(
                "maxDepth" to numberOption(options, "maxDepth", 1),
                "maxItems" to numberOption(options, "maxItems", 20),
                "maxStringLength" to numberOption(options, "maxStringLength", 2000)
            )
        )
    }

    private fun readFrameVariables(
        frame: XStackFrame,
        maxItems: Int,
        maxDepth: Int,
        maxStringLength: Int,
        callback: (Map<String, Any?>) -> Unit
    ) {
        val node = CollectingCompositeNode(maxItems) { children ->
            val output = linkedMapOf<String, Any?>()
            if (children.isEmpty()) {
                callback(output)
                return@CollectingCompositeNode
            }
            var remaining = children.size
            children.forEach { (name, value) ->
                readValue(name, value, maxItems, maxDepth, maxStringLength) { variable ->
                    output[name] = variable
                    remaining -= 1
                    if (remaining == 0) callback(output)
                }
            }
        }
        frame.computeChildren(node)
    }

    private fun readValue(
        name: String,
        value: XValue,
        maxItems: Int,
        maxDepth: Int,
        maxStringLength: Int,
        callback: (Map<String, Any?>) -> Unit
    ) {
        val preview = valuePreview(value, maxStringLength)
        val result = linkedMapOf<String, Any?>(
            "name" to name,
            "kind" to "object",
            "valuePreview" to preview,
            "variablesReference" to 0,
            "truncated" to (maxDepth <= 0)
        )
        if (maxDepth <= 0) {
            callback(result)
            return
        }
        value.computeChildren(
            CollectingCompositeNode(maxItems) { children ->
                if (children.isEmpty()) {
                    result["kind"] = "primitive"
                    result["value"] = preview
                    callback(result)
                    return@CollectingCompositeNode
                }
                val nested = linkedMapOf<String, Any?>()
                var remaining = children.size
                children.forEach { (childName, childValue) ->
                    readValue(childName, childValue, maxItems, maxDepth - 1, maxStringLength) { child ->
                        nested[childName] = child
                        remaining -= 1
                        if (remaining == 0) {
                            result["value"] = nested
                            callback(result)
                        }
                    }
                }
            }
        )
    }

    private fun valuePreview(value: XValue, maxStringLength: Int): String {
        return value.javaClass.simpleName.take(maxStringLength)
    }

    private fun frameMap(frame: XStackFrame): Map<String, Any?> {
        val position = frame.sourcePosition
        return mapOf(
            "id" to System.identityHashCode(frame),
            "name" to frame.javaClass.simpleName,
            "line" to ((position?.line ?: -1) + 1),
            "column" to 1,
            "source" to mapOf(
                "name" to position?.file?.name,
                "path" to position?.file?.path
            )
        )
    }

    private fun numberOption(options: Map<String, Any?>, key: String, fallback: Int): Int {
        val value = options[key] ?: return fallback
        return when (value) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull() ?: fallback
            else -> fallback
        }
    }
}

private class CollectingCompositeNode(
    private val maxItems: Int,
    private val done: (List<Pair<String, XValue>>) -> Unit
) : XCompositeNode {
    private val children = mutableListOf<Pair<String, XValue>>()
    private var finished = false

    override fun addChildren(children: XValueChildrenList, last: Boolean) {
        val count = minOf(children.size(), maxItems - this.children.size)
        for (index in 0 until count) {
            this.children += children.getName(index) to children.getValue(index)
        }
        if (last || this.children.size >= maxItems) finish()
    }

    override fun tooManyChildren(remaining: Int) {
        finish()
    }

    override fun setAlreadySorted(alreadySorted: Boolean) {}

    override fun setErrorMessage(errorMessage: String) {
        finish()
    }

    override fun setErrorMessage(errorMessage: String, link: XDebuggerTreeNodeHyperlink?) {
        finish()
    }

    override fun setMessage(message: String, icon: Icon?, attributes: com.intellij.ui.SimpleTextAttributes, link: XDebuggerTreeNodeHyperlink?) {
        finish()
    }

    override fun isObsolete(): Boolean = finished

    private fun finish() {
        if (finished) return
        finished = true
        ApplicationManager.getApplication().invokeLater {
            done(children)
        }
    }
}
