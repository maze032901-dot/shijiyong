package cn.hermes.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ServiceBaseUrlTest {
    @Test fun acceptsOnlyTheHttpsOrigin() {
        assertEquals("https://preview.example.org", ServiceBaseUrl.normalize(" https://preview.example.org/ "))
        assertEquals("https://preview.example.org:8443", ServiceBaseUrl.normalize("https://preview.example.org:8443"))
    }

    @Test fun buildsTheExactIntakeEndpointAndRejectsMalformedHosts() {
        assertEquals("https://preview.example.org/api/intake", ServiceBaseUrl.intakeEndpoint("https://preview.example.org/"))
        assertThrows(IllegalArgumentException::class.java) {
            ServiceBaseUrl.intakeEndpoint("https://preview.example.org\n-/api/intake")
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServiceBaseUrl.normalize("https:\\/\\/preview.example.org")
        }
    }

    @Test fun rejectsApiPathsAndUnsafeAddresses() {
        listOf("https://preview.example.org/api/intake", "https://preview.example.org?token=secret", "http://preview.example.org").forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { ServiceBaseUrl.normalize(value) }
        }
    }

    @Test fun allowsDebugLoopbackOnlyWhenRequested() {
        assertEquals("http://127.0.0.1:4318", ServiceBaseUrl.normalize("http://127.0.0.1:4318", allowLocalHttp = true))
        assertThrows(IllegalArgumentException::class.java) {
            ServiceBaseUrl.normalize("http://preview.example.org", allowLocalHttp = true)
        }
    }
}
