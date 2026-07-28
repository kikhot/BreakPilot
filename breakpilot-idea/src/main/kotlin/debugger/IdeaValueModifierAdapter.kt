package debugger

import com.intellij.xdebugger.frame.XValueModifier

data class NativeMutationOutcome(
    val applied: Boolean,
    val verified: Boolean,
    val oldValue: String?,
    val newValue: String,
    val message: String? = null
)

class IdeaValueModifierAdapter {
    fun setValue(
        entry: IdeaHandleEntry,
        newValue: String,
        expectedEpoch: Long,
        currentEpoch: () -> Long?,
        readBack: ((String?) -> Unit) -> Unit,
        callback: (NativeMutationOutcome) -> Unit
    ) {
        entry.value.modifierAsync.whenComplete { modifier, error ->
            if (error != null || modifier == null) {
                callback(NativeMutationOutcome(false, false, null, newValue, error?.message ?: "VARIABLE_NOT_MUTABLE"))
                return@whenComplete
            }
            readBack { oldValue ->
                modifier.setValue(newValue, object : XValueModifier.XModificationCallback {
                    override fun valueModified() {
                        if (currentEpoch() != expectedEpoch) {
                            callback(NativeMutationOutcome(false, false, oldValue, newValue, "STALE_RUNTIME_HANDLE"))
                            return
                        }
                        readBack { value ->
                            callback(NativeMutationOutcome(true, value == newValue, oldValue, newValue))
                        }
                    }

                    override fun errorOccurred(errorMessage: String) {
                        callback(NativeMutationOutcome(false, false, oldValue, newValue, errorMessage))
                    }
                })
            }
        }
    }
}
