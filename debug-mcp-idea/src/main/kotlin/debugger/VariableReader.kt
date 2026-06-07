package debugger

import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XDebuggerManager

class VariableReader(private val project: Project) {
    fun currentSnapshot(): Map<String, Any?> {
        val session = XDebuggerManager.getInstance(project).currentSession ?: return emptyMap()
        val frame = session.currentStackFrame ?: return emptyMap()
        // XValue children are asynchronous and renderer-dependent. The real plugin
        // should collect them through XCompositeNode callbacks with depth limits.
        return mapOf(
            "session" to session.sessionName,
            "frame" to frame.sourcePosition?.file?.path
        )
    }
}
