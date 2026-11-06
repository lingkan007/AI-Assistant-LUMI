import asyncio
import unittest
from types import SimpleNamespace
from typing import Any, AsyncIterator
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent_json: list[dict[str, str]] = []
        self.sent_audio: list[bytes] = []

    async def send_json(self, data: Any) -> None:
        self.sent_json.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.sent_audio.append(data)


class FakeSession:
    def __init__(self, turns: list[list[dict[str, object]]]) -> None:
        self.turns = turns
        self.receive_calls = 0
        self.sent_inputs: list[dict[str, Any]] = []

    def receive(self) -> AsyncIterator[Any]:
        turn_index = self.receive_calls
        self.receive_calls += 1
        turn = self.turns[turn_index] if turn_index < len(self.turns) else []

        async def responses() -> AsyncIterator[Any]:
            for message in turn:
                yield SimpleNamespace(server_content=SimpleNamespace(**message))
            if not turn:
                await asyncio.Future()

        return responses()

    async def send_realtime_input(self, *, audio: Any) -> None:
        self.sent_inputs.append({"audio": audio})


class LiveAudioTests(unittest.TestCase):
    def test_microphone_pcm_is_forwarded_to_live_api(self) -> None:
        from google.genai import types

        class InputSocket:
            def __init__(self) -> None:
                self.messages = [
                    {"type": "websocket.receive", "bytes": b"\x01\x00"},
                    {"type": "websocket.disconnect"},
                ]

            async def receive(self) -> dict[str, Any]:
                return self.messages.pop(0)

        session = FakeSession([])
        asyncio.run(main._forward_audio_to_gemini(InputSocket(), session))

        self.assertEqual(len(session.sent_inputs), 1)
        audio = session.sent_inputs[0]["audio"]
        self.assertIsInstance(audio, types.Blob)
        self.assertEqual(audio.data, b"\x01\x00")
        self.assertEqual(audio.mime_type, "audio/pcm;rate=16000")

    def test_live_audio_and_transcripts_are_forwarded_to_browser(self) -> None:
        def response_turn(user_text: str, assistant_text: str, audio: bytes) -> list[dict[str, object]]:
            return [
                {
                    "interrupted": False,
                    "input_transcription": SimpleNamespace(text=user_text),
                    "output_transcription": SimpleNamespace(text=assistant_text),
                    "model_turn": SimpleNamespace(
                        parts=[
                            SimpleNamespace(
                                inline_data=SimpleNamespace(data=audio),
                                text=None,
                            )
                        ]
                    ),
                    "turn_complete": True,
                }
            ]

        first_audio = b"\x10\x00\x20\x00"
        second_audio = b"\x30\x00\x40\x00"
        session = FakeSession(
            [
                response_turn("Question one?", "Answer one.", first_audio),
                response_turn("Question two?", "Answer two.", second_audio),
            ]
        )
        websocket = FakeWebSocket()

        async def receive_two_turns() -> None:
            task = asyncio.create_task(main._forward_gemini_response(websocket, session))
            for _ in range(100):
                if session.receive_calls >= 3 and len(websocket.sent_audio) == 2:
                    break
                await asyncio.sleep(0)
            self.assertEqual(session.receive_calls, 3)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(receive_two_turns())

        self.assertEqual(websocket.sent_audio, [first_audio, second_audio])
        self.assertIn(
            {"type": "state", "state": "TALKING"},
            websocket.sent_json,
        )
        self.assertIn(
            {"type": "transcript", "role": "assistant", "text": "Answer one."},
            websocket.sent_json,
        )
        self.assertIn(
            {
                "type": "transcript",
                "role": "user",
                "text": "Question one?",
            },
            websocket.sent_json,
        )
        self.assertIn(
            {"type": "transcript", "role": "assistant", "text": "Answer two."},
            websocket.sent_json,
        )
        self.assertIn(
            {"type": "transcript", "role": "user", "text": "Question two?"},
            websocket.sent_json,
        )
        self.assertEqual(
            websocket.sent_json[-1], {"type": "state", "state": "IDLE"}
        )

    def test_unconfigured_gemini_returns_actionable_error(self) -> None:
        with patch.object(main, "GEMINI_API_KEY", None):
            with TestClient(main.app) as client:
                with client.websocket_connect("/ws") as websocket:
                    error = websocket.receive_json()

        self.assertEqual(error["type"], "error")
        self.assertIn("GEMINI_API_KEY", error["message"])


if __name__ == "__main__":
    unittest.main()
