package settings

import com.intellij.openapi.components.service
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import security.ConsentManager
import java.awt.BorderLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea

class BreakPilotSettingsConfigurable(private val project: Project) : SearchableConfigurable {
    private var panel: JPanel? = null
    private var safeInspections: JComboBox<SafeInspectionsMode>? = null
    private var debugControls: JComboBox<DebugControlsMode>? = null
    private var allowHighRisk: JCheckBox? = null
    private var trustedProject: JCheckBox? = null
    private var trustedOnly: JCheckBox? = null
    private var actions: JTextArea? = null
    private var expressionPatterns: JTextArea? = null

    override fun getId(): String = "breakpilot.settings"

    override fun getDisplayName(): String = "BreakPilot"

    override fun createComponent(): JComponent {
        val root = JPanel(BorderLayout())
        val form = JPanel(GridBagLayout())
        val constraints = GridBagConstraints().apply {
            fill = GridBagConstraints.HORIZONTAL
            anchor = GridBagConstraints.NORTHWEST
            weightx = 1.0
        }
        var row = 0

        safeInspections = JComboBox(SafeInspectionsMode.entries.toTypedArray())
        debugControls = JComboBox(DebugControlsMode.entries.toTypedArray())
        allowHighRisk = JCheckBox("Allow persistent high-risk approvals")
        trustedProject = JCheckBox("Trust this project for BreakPilot safe inspections")
        trustedOnly = JCheckBox("Apply high-risk allowlist only in trusted projects")
        actions = JTextArea(4, 48)
        expressionPatterns = JTextArea(4, 48)

        addRow(form, constraints, row++, "Safe inspections", safeInspections!!)
        addRow(form, constraints, row++, "Debug controls", debugControls!!)
        addRow(form, constraints, row++, "", trustedProject!!)
        addRow(form, constraints, row++, "High-risk actions", allowHighRisk!!)
        addRow(form, constraints, row++, "", trustedOnly!!)
        addRow(form, constraints, row++, "Allowlisted actions", JScrollPane(actions!!))
        addRow(form, constraints, row++, "Expression allowlist patterns", JScrollPane(expressionPatterns!!))

        val resetPanel = JPanel()
        resetPanel.add(JButton("Reset Current Project Decisions").apply {
            addActionListener {
                project.service<BreakPilotProjectConsentState>().resetProjectDecisions()
                reset()
            }
        })
        resetPanel.add(JButton("Reset Current Debug Session Decisions").apply {
            addActionListener {
                project.service<ConsentManager>().resetSessionDecisions()
            }
        })
        resetPanel.add(JButton("Reset All BreakPilot Decisions").apply {
            addActionListener {
                service<BreakPilotSettingsState>().resetAll()
                project.service<BreakPilotProjectConsentState>().resetAllProjectState()
                project.service<ConsentManager>().resetSessionDecisions()
                reset()
            }
        })

        constraints.gridx = 0
        constraints.gridy = row
        constraints.gridwidth = 2
        form.add(resetPanel, constraints)
        root.add(form, BorderLayout.NORTH)
        panel = root
        reset()
        return root
    }

    override fun isModified(): Boolean {
        val settings = service<BreakPilotSettingsState>().state
        val projectState = project.service<BreakPilotProjectConsentState>().state
        return selectedSafeMode().id != settings.safeInspectionsMode ||
            selectedDebugMode().id != settings.debugControlsMode ||
            checked(allowHighRisk) != settings.allowPersistentHighRiskApprovals ||
            checked(trustedOnly) != settings.allowlistTrustedProjectsOnly ||
            checked(trustedProject) != projectState.trustedProject ||
            listFromText(actions?.text.orEmpty()) != settings.allowedActions ||
            listFromText(expressionPatterns?.text.orEmpty()) != settings.allowedExpressionPatterns
    }

    override fun apply() {
        val settingsService = service<BreakPilotSettingsState>()
        val settings = settingsService.state
        // Advanced high-risk persistence is deliberately one warning away from
        // the default path because it can allow state-changing evaluate calls.
        if (!settings.allowPersistentHighRiskApprovals && checked(allowHighRisk)) {
            Messages.showWarningDialog(
                project,
                "Persistent high-risk approvals can allow BreakPilot to run expressions that may change runtime state. Use allowlists narrowly.",
                "BreakPilot High-Risk Approvals"
            )
        }
        settings.safeInspectionsMode = selectedSafeMode().id
        settings.debugControlsMode = selectedDebugMode().id
        settings.allowPersistentHighRiskApprovals = checked(allowHighRisk)
        settings.allowlistTrustedProjectsOnly = checked(trustedOnly)
        settings.allowedActions = listFromText(actions?.text.orEmpty()).toMutableList()
        settings.allowedExpressionPatterns = listFromText(expressionPatterns?.text.orEmpty()).toMutableList()
        project.service<BreakPilotProjectConsentState>().state.trustedProject = checked(trustedProject)
    }

    override fun reset() {
        val settings = service<BreakPilotSettingsState>().state
        val projectState = project.service<BreakPilotProjectConsentState>().state
        safeInspections?.selectedItem = SafeInspectionsMode.fromId(settings.safeInspectionsMode)
        debugControls?.selectedItem = DebugControlsMode.fromId(settings.debugControlsMode)
        allowHighRisk?.isSelected = settings.allowPersistentHighRiskApprovals
        trustedOnly?.isSelected = settings.allowlistTrustedProjectsOnly
        trustedProject?.isSelected = projectState.trustedProject
        actions?.text = settings.allowedActions.joinToString("\n")
        expressionPatterns?.text = settings.allowedExpressionPatterns.joinToString("\n")
    }

    override fun disposeUIResources() {
        panel = null
        safeInspections = null
        debugControls = null
        allowHighRisk = null
        trustedProject = null
        trustedOnly = null
        actions = null
        expressionPatterns = null
    }

    private fun selectedSafeMode(): SafeInspectionsMode {
        return safeInspections?.selectedItem as? SafeInspectionsMode ?: SafeInspectionsMode.AskOncePerProject
    }

    private fun selectedDebugMode(): DebugControlsMode {
        return debugControls?.selectedItem as? DebugControlsMode ?: DebugControlsMode.AskOncePerSession
    }

    private fun checked(box: JCheckBox?): Boolean = box?.isSelected == true

    private fun listFromText(text: String): List<String> {
        // The settings UI accepts one entry per line for readability, while
        // commas make quick edits convenient when pasting compact allowlists.
        return text.split('\n', ',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
    }

    private fun addRow(
        form: JPanel,
        constraints: GridBagConstraints,
        row: Int,
        label: String,
        component: JComponent
    ) {
        constraints.gridy = row
        constraints.gridx = 0
        constraints.gridwidth = 1
        constraints.weightx = 0.0
        form.add(JLabel(label), constraints)
        constraints.gridx = 1
        constraints.weightx = 1.0
        form.add(component, constraints)
    }
}
