package debugger

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.project.Project
import com.intellij.util.Alarm
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XFullValueEvaluator
import com.intellij.xdebugger.frame.XStackFrame
import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueChildrenList
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.XValuePlace
import com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink
import com.intellij.xdebugger.frame.presentation.XValuePresentation
import com.intellij.xdebugger.impl.breakpoints.XExpressionImpl
import javax.swing.Icon

class VariableReader(
    private val project: Project,
    private val tracker: IdeSessionTracker
) {
    private val presentationAlarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, project)

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
        readPresentation(value, maxStringLength) { presentation ->
            val preview = presentation.valuePreview
            val result = linkedMapOf<String, Any?>(
                "name" to name,
                "kind" to "object",
                "valuePreview" to preview,
                "variablesReference" to 0,
                "truncated" to false
            )
            if (!presentation.type.isNullOrBlank()) {
                result["type"] = presentation.type
            }
            if (!presentation.presentationError.isNullOrBlank()) {
                result["presentationError"] = presentation.presentationError
            }
            if (presentation.hasChildren == false) {
                result["kind"] = "primitive"
                result["value"] = preview
                callback(result)
                return@readPresentation
            }
            if (maxDepth <= 0) {
                result["truncated"] = true
                callback(result)
                return@readPresentation
            }
            try {
                value.computeChildren(
                    CollectingCompositeNode(maxItems) { children ->
                        if (children.isEmpty()) {
                            if (presentation.hasChildren == true) {
                                result["value"] = linkedMapOf<String, Any?>()
                            } else {
                                result["kind"] = "primitive"
                                result["value"] = preview
                            }
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
            } catch (error: Throwable) {
                result["kind"] = "primitive"
                result["value"] = preview
                result["truncated"] = true
                callback(result)
            }
        }
    }

    private fun readPresentation(
        value: XValue,
        maxStringLength: Int,
        callback: (PresentationData) -> Unit
    ) {
        val node = CollectingValueNode(maxStringLength, callback)
        presentationAlarm.addRequest(
            {
                node.finishUnavailable("Presentation callback was not invoked within 1000 ms.")
            },
            1000
        )
        try {
            value.computePresentation(node, XValuePlace.TREE)
        } catch (error: Throwable) {
            node.finishUnavailable(error.message ?: error.javaClass.name)
        }
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

private data class PresentationData(
    val valuePreview: String,
    val type: String?,
    val hasChildren: Boolean?,
    val presentationError: String? = null
)

private class CollectingValueNode(
    private val maxStringLength: Int,
    private val done: (PresentationData) -> Unit
) : XValueNode {
    private var finished = false

    override fun setPresentation(icon: Icon?, type: String?, value: String, hasChildren: Boolean) {
        finish(
            PresentationData(
                valuePreview = truncateDisplay(value),
                type = type?.takeIf { it.isNotBlank() }?.let { truncateDisplay(it) },
                hasChildren = hasChildren
            )
        )
    }

    override fun setPresentation(icon: Icon?, presentation: XValuePresentation, hasChildren: Boolean) {
        val rendered = PresentationTextCollector()
        try {
            presentation.renderValue(rendered)
            finish(
                PresentationData(
                    valuePreview = truncateDisplay(rendered.text()),
                    type = presentation.type?.takeIf { it.isNotBlank() }?.let { truncateDisplay(it) },
                    hasChildren = hasChildren
                )
            )
        } catch (error: Throwable) {
            finishUnavailable(error.message ?: error.javaClass.name, hasChildren)
        }
    }

    override fun setFullValueEvaluator(fullValueEvaluator: XFullValueEvaluator) {}

    override fun isObsolete(): Boolean = finished

    fun finishUnavailable(error: String, hasChildren: Boolean? = null) {
        finish(
            PresentationData(
                valuePreview = "<unavailable>",
                type = null,
                hasChildren = hasChildren,
                presentationError = error
            )
        )
    }

    private fun finish(data: PresentationData) {
        if (finished) return
        finished = true
        ApplicationManager.getApplication().invokeLater {
            done(data)
        }
    }

    private fun truncateDisplay(value: String): String {
        if (value.length <= maxStringLength) return value
        return value.take(maxStringLength)
    }
}

private class PresentationTextCollector : XValuePresentation.XValueTextRenderer {
    private val builder = StringBuilder()

    fun text(): String = builder.toString()

    override fun renderValue(value: String) {
        builder.append(value)
    }

    override fun renderStringValue(value: String) {
        builder.append(value)
    }

    override fun renderNumericValue(value: String) {
        builder.append(value)
    }

    override fun renderKeywordValue(value: String) {
        builder.append(value)
    }

    override fun renderValue(value: String, key: TextAttributesKey) {
        builder.append(value)
    }

    override fun renderStringValue(value: String, additionalSpecialCharsToHighlight: String?, maxLength: Int) {
        builder.append(if (maxLength >= 0) value.take(maxLength) else value)
    }

    override fun renderComment(comment: String) {
        builder.append(comment)
    }

    override fun renderSpecialSymbol(symbol: String) {
        builder.append(symbol)
    }

    override fun renderError(error: String) {
        builder.append(error)
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
