import unittest
from types import SimpleNamespace

from agent.provider_clients import build_provider_request


class DashboardAiProviderClientTest(unittest.TestCase):
    def test_gemini_request_uses_local_key(self):
        request = build_provider_request(
            SimpleNamespace(provider="gemini", model="gemini-3-flash-preview", provider_key="gem-key", base_url=None),
            "Xin chào",
        )
        self.assertIn("generativelanguage.googleapis.com", request.url)
        self.assertIn("key=gem-key", request.url)
        self.assertNotIn("Authorization", request.headers)

    def test_qwen_request_uses_openai_compatible_endpoint(self):
        request = build_provider_request(
            SimpleNamespace(
                provider="openai-compatible",
                model="qwen-plus",
                base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                provider_key="qwen-key",
            ),
            "Xin chào",
        )
        self.assertEqual(request.url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions")
        self.assertEqual(request.headers["Authorization"], "Bearer qwen-key")
        self.assertEqual(request.body["model"], "qwen-plus")

    def test_deepseek_uses_default_base_url(self):
        request = build_provider_request(
            SimpleNamespace(provider="deepseek", model="deepseek-v4-flash", provider_key="deep-key", base_url=None),
            "Xin chào",
        )
        self.assertEqual(request.url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.headers["Authorization"], "Bearer deep-key")

    def test_missing_key_fails_with_vietnamese_message(self):
        with self.assertRaisesRegex(ValueError, "chưa được đồng bộ"):
            build_provider_request(SimpleNamespace(provider="deepseek", model="deepseek-v4-flash", provider_key=None, base_url=None), "Xin chào")


if __name__ == "__main__":
    unittest.main()
