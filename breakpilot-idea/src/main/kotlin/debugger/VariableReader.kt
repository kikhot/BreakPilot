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
import com.intellij.xdebugger.frame.XExecutionStack
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
    private val handles = PauseScopedHandleRegistry()
    private val modifier = IdeaValueModifierAdapter()

    init {
        tracker.onEpochChanged { handles.invalidate(it) }
    }

    fun handle(message: BridgeMessage, bridge: BridgeClient) {
        val session = tracker.find(message.ideSessionId)
        if (session == null) {
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeVariablesSnapshot,
                    requestId = message.requestId,
                    sessionId = message.sessionId,
                    ideSessionId = message.ideSessionId,
                    originRequestId = message.originRequestId,
                    pauseEpoch = message.expectedPauseEpoch,
                    error = mapOf(
                        "code" to "IDE_SESSION_NOT_FOUND",
                        "message" to "IDE debug session was not found."
                    )
                )
            )
            return
        }
        val options = message.options
        val epoch = tracker.pauseEpoch(message.ideSessionId)
        if (message.expectedPauseEpoch != null && message.expectedPauseEpoch != epoch) {
            sendError(bridge, message, "STALE_RUNTIME_HANDLE", "Runtime request belongs to another paused state.")
            return
        }
        val ref = message.ref as? String
        if (ref != null) {
            val entry = handles.resolve(ref, message.ideSessionId ?: "", epoch ?: -1)
            if (entry == null) {
                sendError(bridge, message, "STALE_RUNTIME_HANDLE", "Runtime reference is stale or foreign.")
                return
            }
            entry.value.computeChildren(CollectingCompositeNode(numberOption(options, "maxItems", 20)) { children ->
                val items = mutableListOf<Map<String, Any?>>()
                if (children.isEmpty()) {
                    sendRefResult(bridge, message, ref, epoch ?: 0, items)
                    return@CollectingCompositeNode
                }
                var remaining = children.size
                children.forEach { (name, value) ->
                    readValue(name, value, 20, 1, 2000, sessionId = message.ideSessionId, pauseEpoch = epoch) { variable ->
                        items += variable
                        remaining -= 1
                        if (remaining == 0) sendRefResult(bridge, message, ref, epoch ?: 0, items)
                    }
                }
            })
            return
        }
        currentSnapshot(session, options) { snapshot ->
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeVariablesSnapshot,
                    requestId = message.requestId,
                    sessionId = message.sessionId,
                    ideSessionId = message.ideSessionId,
                    originRequestId = message.originRequestId,
                    pauseEpoch = epoch,
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
        val maxItems = numberOption(options, "maxItems", 20)
        val maxDepth = numberOption(options, "maxDepth", 1)
        val maxStringLength = numberOption(options, "maxStringLength", 2000)
        val levels = numberOption(options, "levels", 20)
        readStackSnapshot(session, options, levels) { stack ->
            val frame = stack.selectedFrame
            if (frame == null) {
                callback(baseSnapshot(session, stack.threads, emptyList(), emptyMap(), options, stack.threadId, true))
                return@readStackSnapshot
            }
            readFrameVariables(session, frame, maxItems, maxDepth, maxStringLength) { variables ->
                callback(
                    baseSnapshot(
                        session,
                        stack.threads,
                        stack.frames.map { frameMap(it) },
                        variables,
                        options,
                        stack.threadId,
                        stack.partial
                    )
                )
            }
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
                    readValue("result", result, 10, 1, 2000, 5000, ideSessionId, tracker.pauseEpoch(ideSessionId)) { variable ->
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
        threads: List<Map<String, Any?>>,
        stackFrames: List<Map<String, Any?>>,
        variables: Map<String, Any?>,
        options: Map<String, Any?>,
        threadId: Int?,
        partial: Boolean
    ): Map<String, Any?> {
        return mapOf(
            "source" to "ide",
            "ide" to "idea",
            "language" to "idea",
            "threadId" to (threadId ?: 0),
            "frameId" to (stackFrames.firstOrNull()?.get("id")),
            "profile" to (options["profile"] ?: "focused"),
            "threads" to threads,
            "stackFrames" to stackFrames,
            "partial" to partial,
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

    private fun readStackSnapshot(
        session: XDebugSession,
        options: Map<String, Any?>,
        levels: Int,
        callback: (StackSnapshotData) -> Unit
    ) {
        val context = session.suspendContext
        val stacks = context?.executionStacks?.toList() ?: emptyList()
        val activeStack = context?.activeExecutionStack ?: stacks.firstOrNull()
        val requestedThreadId = nullableNumberOption(options, "threadId")
        if (stacks.isEmpty()) {
            val frame = session.currentStackFrame
            val frames = if (frame == null) emptyList() else listOf(frame)
            callback(
                StackSnapshotData(
                    threadId = 0,
                    threads = if (frame == null) emptyList() else listOf(
                        mapOf(
                            "id" to 0,
                            "name" to "current",
                            "state" to "paused",
                            "isCurrent" to true,
                            "frameCount" to frames.size,
                            "partial" to true
                        )
                    ),
                    frames = frames,
                    selectedFrame = frames.getOrNull(numberOption(options, "frameIndex", 0)),
                    partial = true
                )
            )
            return
        }

        val selectedStack = stacks.firstOrNull { stackThreadId(it) == requestedThreadId } ?: activeStack ?: stacks.first()
        val snapshots = mutableListOf<StackSnapshot>()
        var remaining = stacks.size
        fun maybeDone() {
            if (remaining != 0) return
            val selected = snapshots.firstOrNull { it.threadId == stackThreadId(selectedStack) } ?: snapshots.first()
            val frameIndex = numberOption(options, "frameIndex", 0)
            val requestedFrameId = nullableNumberOption(options, "frameId")
            val selectedFrame = selected.frames.firstOrNull { System.identityHashCode(it) == requestedFrameId }
                ?: selected.frames.getOrNull(frameIndex)
                ?: selected.frames.firstOrNull()
            callback(
                StackSnapshotData(
                    threadId = selected.threadId,
                    threads = snapshots.sortedByDescending { it.isCurrent }.map { snapshot ->
                        mapOf(
                            "id" to snapshot.threadId,
                            "name" to snapshot.name,
                            "state" to "paused",
                            "isCurrent" to snapshot.isCurrent,
                            "frameCount" to snapshot.frames.size,
                            "partial" to snapshot.partial
                        )
                    },
                    frames = selected.frames,
                    selectedFrame = selectedFrame,
                    partial = selected.partial
                )
            )
        }

        stacks.forEach { stack ->
            val isCurrent = stack === activeStack
            val frameLimit = if (stack === selectedStack) levels else 1
            readStackFrames(stack, frameLimit) { frames, partial ->
                snapshots += StackSnapshot(
                    threadId = stackThreadId(stack),
                    name = stack.displayName ?: stack.javaClass.simpleName,
                    isCurrent = isCurrent,
                    frames = frames,
                    partial = partial
                )
                remaining -= 1
                maybeDone()
            }
        }
    }

    private fun readStackFrames(
        stack: XExecutionStack,
        maxFrames: Int,
        callback: (List<XStackFrame>, Boolean) -> Unit
    ) {
        val container = CollectingStackFrameContainer(maxFrames) { frames, partial ->
            callback(if (frames.isEmpty()) stack.topFrame?.let { listOf(it) } ?: emptyList() else frames, partial)
        }
        presentationAlarm.addRequest(
            {
                container.finishUnavailable()
            },
            1000
        )
        try {
            stack.computeStackFrames(0, container)
        } catch (error: Throwable) {
            callback(stack.topFrame?.let { listOf(it) } ?: emptyList(), true)
        }
    }

    private fun readFrameVariables(
        session: XDebugSession,
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
                readValue(name, value, maxItems, maxDepth, maxStringLength, sessionId = tracker.sessionId(session), pauseEpoch = tracker.pauseEpoch(tracker.sessionId(session))) { variable ->
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
        presentationTimeoutMs: Long = 1000,
        sessionId: String? = null,
        pauseEpoch: Long? = null,
        callback: (Map<String, Any?>) -> Unit
    ) {
        readPresentation(value, maxStringLength, presentationTimeoutMs) { presentation ->
            val preview = presentation.valuePreview
            val result = linkedMapOf<String, Any?>(
                "name" to name,
                "kind" to "object",
                "valuePreview" to preview,
                "variablesReference" to 0,
                "truncated" to false
            )
            if (sessionId != null && pauseEpoch != null) {
                val ref = handles.register(
                    IdeaHandleEntry(
                        sessionId = sessionId,
                        pauseEpoch = pauseEpoch,
                        value = value,
                        name = name,
                        frameKey = null,
                        evaluateName = value.evaluationExpression,
                        modifiable = value.modifier != null
                    )
                )
                result["ref"] = ref
                result["variablesReference"] = ref
                result["pauseEpoch"] = pauseEpoch
                result["modifiable"] = value.modifier != null
                result["mutationMode"] = if (value.modifier != null) "native" else null
            }
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
                            readValue(childName, childValue, maxItems, maxDepth - 1, maxStringLength, sessionId = sessionId, pauseEpoch = pauseEpoch) { child ->
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
        timeoutMs: Long = 1000,
        callback: (PresentationData) -> Unit
    ) {
        val node = CollectingValueNode(maxStringLength, callback)
        presentationAlarm.addRequest(
            {
                node.finishUnavailable("Presentation callback was not invoked within ${timeoutMs} ms.")
            },
            timeoutMs
        )
        try {
            value.computePresentation(node, XValuePlace.TREE)
        } catch (error: Throwable) {
            node.finishUnavailable(error.message ?: error.javaClass.name)
        }
    }

    fun setNativeValue(
        ideSessionId: String?,
        ref: String,
        newValue: String?,
        expectedEpoch: Long?,
        callback: (Map<String, Any?>?, String?) -> Unit
    ) {
        if (ideSessionId == null || newValue == null || expectedEpoch == null) {
            callback(null, "INVALID_ARGUMENT")
            return
        }
        val entry = handles.resolve(ref, ideSessionId, expectedEpoch)
        if (entry == null) {
            callback(null, "STALE_RUNTIME_HANDLE")
            return
        }
        modifier.setValue(
            entry,
            newValue,
            expectedEpoch,
            { tracker.pauseEpoch(ideSessionId) },
            { done -> readPresentation(entry.value, 2000) { presentation -> done(presentation.valuePreview) } }
        ) { outcome ->
            if (!outcome.applied && outcome.message != null) {
                callback(null, outcome.message)
            } else {
                callback(
                    mapOf(
                        "ref" to ref,
                        "oldValue" to outcome.oldValue,
                        "newValue" to outcome.newValue,
                        "applied" to outcome.applied,
                        "verified" to outcome.verified,
                        "mutationMode" to "native"
                    ),
                    null
                )
            }
        }
    }

    private fun sendError(bridge: BridgeClient, message: BridgeMessage, code: String, text: String) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeVariablesSnapshot,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
                error = mapOf("code" to code, "message" to text)
            )
        )
    }

    private fun sendRefResult(bridge: BridgeClient, message: BridgeMessage, ref: String, epoch: Long, items: List<Map<String, Any?>>) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeVariablesSnapshot,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = epoch,
                result = mapOf("ref" to ref, "pauseEpoch" to epoch, "items" to items)
            )
        )
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

    private fun nullableNumberOption(options: Map<String, Any?>, key: String): Int? {
        val value = options[key] ?: return null
        return when (value) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        }
    }

    private fun stackThreadId(stack: XExecutionStack): Int = System.identityHashCode(stack)
}

private data class StackSnapshot(
    val threadId: Int,
    val name: String,
    val isCurrent: Boolean,
    val frames: List<XStackFrame>,
    val partial: Boolean
)

private data class StackSnapshotData(
    val threadId: Int,
    val threads: List<Map<String, Any?>>,
    val frames: List<XStackFrame>,
    val selectedFrame: XStackFrame?,
    val partial: Boolean
)

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
        if (isPendingPresentation(value)) return
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
            if (isPendingPresentation(rendered.text())) return
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

    private fun isPendingPresentation(value: String): Boolean {
        val normalized = value.replace("…", "...").trim().lowercase()
        return normalized == "collecting data..." || normalized == "collecting data"
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

private class CollectingStackFrameContainer(
    private val maxFrames: Int,
    private val done: (List<XStackFrame>, Boolean) -> Unit
) : XExecutionStack.XStackFrameContainer {
    private val frames = mutableListOf<XStackFrame>()
    private var finished = false

    override fun addStackFrames(stackFrames: List<XStackFrame>, last: Boolean) {
        val count = minOf(stackFrames.size, maxFrames - frames.size)
        for (index in 0 until count) {
            frames += stackFrames[index]
        }
        if (last || frames.size >= maxFrames) finish(partial = !last)
    }

    override fun errorOccurred(errorMessage: String) {
        finish(partial = true)
    }

    override fun isObsolete(): Boolean = finished

    fun finishUnavailable() {
        finish(partial = true)
    }

    private fun finish(partial: Boolean) {
        if (finished) return
        finished = true
        ApplicationManager.getApplication().invokeLater {
            done(frames, partial)
        }
    }
}
