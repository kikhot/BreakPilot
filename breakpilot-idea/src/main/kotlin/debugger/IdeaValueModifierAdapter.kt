package debugger

import com.intellij.xdebugger.frame.XValueModifier
import java.util.concurrent.atomic.AtomicBoolean

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
        val completed = AtomicBoolean(false)
        val preReadHandled = AtomicBoolean(false)
        fun complete(outcome: NativeMutationOutcome) {
            if (completed.compareAndSet(false, true)) callback(outcome)
        }
        entry.value.modifierAsync.whenComplete { modifier, error ->
            if (error != null || modifier == null) {
                complete(NativeMutationOutcome(false, false, null, newValue, error?.message ?: "VARIABLE_NOT_MUTABLE"))
                return@whenComplete
            }
            if (currentEpoch() != expectedEpoch) {
                complete(NativeMutationOutcome(false, false, null, newValue, "STALE_RUNTIME_HANDLE"))
                return@whenComplete
            }
            readBack { oldValue ->
                if (!preReadHandled.compareAndSet(false, true) || completed.get()) return@readBack
                if (currentEpoch() != expectedEpoch) {
                    complete(NativeMutationOutcome(false, false, oldValue, newValue, "STALE_RUNTIME_HANDLE"))
                    return@readBack
                }
                modifier.setValue(newValue, object : XValueModifier.XModificationCallback {
                    override fun valueModified() {
                        if (currentEpoch() != expectedEpoch) {
                            complete(NativeMutationOutcome(true, false, oldValue, newValue, "STALE_RUNTIME_HANDLE"))
                            return
                        }
                        readBack { value ->
                            val stillCurrent = currentEpoch() == expectedEpoch
                            complete(
                                NativeMutationOutcome(
                                    true,
                                    stillCurrent && value == newValue,
                                    oldValue,
                                    newValue,
                                    if (stillCurrent) null else "STALE_RUNTIME_HANDLE"
                                )
                            )
                        }
                    }

                    override fun errorOccurred(errorMessage: String) {
                        complete(NativeMutationOutcome(false, false, oldValue, newValue, errorMessage))
                    }
                })
            }
        }
    }
}
