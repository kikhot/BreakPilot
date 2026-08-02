package debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.SimpleColoredText
import com.intellij.xdebugger.frame.XStackFrame

object StackFramePresentationModel {
    private val providerNames = setOf("JavaStackFrame", "XStackFrame", "HiddenStackFramesItem")

    fun semanticName(presentation: String?, fileName: String?, line: Int): String {
        val trimmed = presentation?.trim().orEmpty()
        val semantic = if (trimmed in providerNames) "" else removeSourceSuffix(trimmed, fileName, line)
        if (semantic.isNotBlank()) return semantic
        val source = fileName?.takeIf { it.isNotBlank() } ?: "unknown source"
        return if (line > 0) "$source:$line" else source
    }

    private fun removeSourceSuffix(value: String, fileName: String?, line: Int): String {
        if (value.isBlank() || fileName.isNullOrBlank() || line <= 0) return value
        val escapedFile = Regex.escape(fileName)
        return value
            .replace(Regex(":$line,.*$"), "")
            .replace(Regex(":$line,\\s*$escapedFile$"), "")
            .replace(Regex("\\s+\\($escapedFile:$line\\)$"), "")
            .trim()
    }
}

object StackFramePresentationReader {
    fun semanticName(frame: XStackFrame): String {
        val position = frame.sourcePosition
        val line = (position?.line ?: -1) + 1
        val fileName = position?.file?.name
        var presentation: String? = null
        val readPresentation = {
            try {
                val text = SimpleColoredText()
                frame.customizePresentation(text)
                presentation = text.texts.joinToString("").trim()
            } catch (_: Throwable) {
                presentation = null
            }
        }
        val application = ApplicationManager.getApplication()
        if (application.isDispatchThread) {
            readPresentation()
        } else {
            try {
                application.invokeAndWait(readPresentation)
            } catch (_: Throwable) {
                presentation = null
            }
        }
        return StackFramePresentationModel.semanticName(presentation, fileName, line)
    }
}
