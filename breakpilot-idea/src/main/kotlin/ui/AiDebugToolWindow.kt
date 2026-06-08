package ui

import javax.swing.JPanel
import javax.swing.JTextArea
import java.awt.BorderLayout

class AiDebugToolWindow : JPanel(BorderLayout()) {
    private val log = JTextArea()

    init {
        add(log, BorderLayout.CENTER)
    }

    fun append(message: String) {
        log.append(message)
        log.append("\n")
    }
}
