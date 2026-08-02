package debugger

import kotlin.test.Test
import kotlin.test.assertEquals

class StackFramePresentationModelTest {
    @Test
    fun `semantic names retain business methods and remove source suffixes`() {
        assertEquals(
            "HelloController.hello()",
            StackFramePresentationModel.semanticName(
                "HelloController.hello():21, HelloController.java",
                "HelloController.java",
                21
            )
        )
        assertEquals(
            "com.acme.HelloController.hello(java.lang.String)",
            StackFramePresentationModel.semanticName(
                "  com.acme.HelloController.hello(java.lang.String)  ",
                "HelloController.java",
                21
            )
        )
        assertEquals(
            "hello",
            StackFramePresentationModel.semanticName(
                "hello:21, HelloController (com.example.demo.controller)",
                "HelloController.java",
                21
            )
        )
    }

    @Test
    fun `provider implementation names and empty presentations use source fallback`() {
        assertEquals(
            "HelloController.java:21",
            StackFramePresentationModel.semanticName("JavaStackFrame", "HelloController.java", 21)
        )
        assertEquals(
            "HelloController.java:21",
            StackFramePresentationModel.semanticName("   ", "HelloController.java", 21)
        )
    }
}
