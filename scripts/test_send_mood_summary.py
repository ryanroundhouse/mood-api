import importlib.util
import os
import pathlib
import sqlite3
import sys
import tempfile
import types
import unittest


def load_send_mood_summary_module():
    try:
        import nltk  # type: ignore
        nltk.download = lambda *args, **kwargs: True
    except ModuleNotFoundError:
        nltk = types.ModuleType('nltk')
        nltk.download = lambda *args, **kwargs: True
        nltk.data = types.SimpleNamespace(find=lambda *args, **kwargs: True)

        opinion_lexicon = types.SimpleNamespace(positive=lambda: ['good', 'great'])
        wordnet = types.SimpleNamespace(synsets=lambda *args, **kwargs: [])

        nltk_corpus = types.ModuleType('nltk.corpus')
        nltk_corpus.opinion_lexicon = opinion_lexicon
        nltk_corpus.wordnet = wordnet

        sys.modules['nltk'] = nltk
        sys.modules['nltk.corpus'] = nltk_corpus

    if 'dotenv' not in sys.modules:
        dotenv = types.ModuleType('dotenv')
        dotenv.load_dotenv = lambda *args, **kwargs: None
        sys.modules['dotenv'] = dotenv

    if 'openai' not in sys.modules:
        openai = types.ModuleType('openai')

        class FakeOpenAI:
            def __init__(self, *args, **kwargs):
                self.chat = types.SimpleNamespace(
                    completions=types.SimpleNamespace(
                        create=lambda *a, **k: types.SimpleNamespace(
                            choices=[types.SimpleNamespace(message=types.SimpleNamespace(content='{}'))]
                        )
                    )
                )

        openai.OpenAI = FakeOpenAI
        sys.modules['openai'] = openai

    if 'Crypto' not in sys.modules:
        crypto_module = types.ModuleType('Crypto')
        cipher_module = types.ModuleType('Crypto.Cipher')

        class FakeAES:
            MODE_GCM = 'MODE_GCM'

            @staticmethod
            def new(*args, **kwargs):
                return types.SimpleNamespace(
                    decrypt_and_verify=lambda ciphertext, tag: b'',
                    encrypt_and_digest=lambda payload: (payload, b''),
                )

        cipher_module.AES = FakeAES
        crypto_module.Cipher = cipher_module
        sys.modules['Crypto'] = crypto_module
        sys.modules['Crypto.Cipher'] = cipher_module

    script_path = pathlib.Path(__file__).with_name('send-mood-summary.py')
    spec = importlib.util.spec_from_file_location('send_mood_summary', script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestSendMoodSummary(unittest.TestCase):
    def setUp(self):
        self.module = load_send_mood_summary_module()
        self.temp_db = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
        self.temp_db.close()
        self.addCleanup(self.cleanup_temp_db)

        conn = sqlite3.connect(self.temp_db.name)
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE moods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER NOT NULL,
                datetime TEXT NOT NULL,
                rating INTEGER NOT NULL,
                comment TEXT,
                activities TEXT
            )
            """
        )
        cursor.execute(
            """
            CREATE TABLE sleep_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER NOT NULL,
                calendarDate TEXT NOT NULL,
                durationInHours REAL,
                deepSleepDurationInHours REAL,
                lightSleepDurationInHours REAL,
                remSleepInHours REAL,
                awakeDurationInHours REAL,
                startTimeInSeconds INTEGER,
                startTimeOffsetInSeconds INTEGER
            )
            """
        )
        cursor.execute(
            """
            CREATE TABLE daily_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER NOT NULL,
                calendarDate TEXT NOT NULL,
                steps INTEGER,
                distanceInMeters REAL,
                activeTimeInHours REAL,
                floorsClimbed INTEGER,
                averageStressLevel INTEGER,
                maxStressLevel INTEGER,
                stressDurationInMinutes REAL
            )
            """
        )
        cursor.execute(
            """
            CREATE TABLE breathing_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER NOT NULL,
                routineType TEXT NOT NULL,
                cycleMode TEXT NOT NULL,
                targetCycles INTEGER,
                completedCycles INTEGER NOT NULL,
                status TEXT NOT NULL,
                startedAt TEXT NOT NULL,
                endedAt TEXT NOT NULL,
                durationSeconds INTEGER NOT NULL,
                calendarDate TEXT NOT NULL,
                triggerContext TEXT,
                audioEnabled INTEGER,
                countdownCompleted INTEGER,
                exitReason TEXT
            )
            """
        )

        cursor.execute(
            """
            INSERT INTO moods (userId, datetime, rating, comment, activities)
            VALUES (?, ?, ?, ?, ?)
            """,
            (1, '2026-03-20T09:00:00', 3, None, '["work"]'),
        )
        cursor.execute(
            """
            INSERT INTO breathing_sessions (
                userId, routineType, cycleMode, targetCycles, completedCycles, status,
                startedAt, endedAt, durationSeconds, calendarDate, triggerContext,
                audioEnabled, countdownCompleted, exitReason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                1,
                'box_breathing',
                '5_cycles',
                5,
                5,
                'completed',
                '2026-03-20T09:05:00',
                '2026-03-20T09:10:00',
                300,
                '2026-03-20',
                'home_panel',
                1,
                1,
                None,
            ),
        )
        cursor.execute(
            """
            INSERT INTO breathing_sessions (
                userId, routineType, cycleMode, targetCycles, completedCycles, status,
                startedAt, endedAt, durationSeconds, calendarDate, triggerContext,
                audioEnabled, countdownCompleted, exitReason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                1,
                'four_seven_eight',
                'infinite',
                None,
                8,
                'exited_early',
                '2026-03-21T09:05:00',
                '2026-03-21T09:16:00',
                660,
                '2026-03-21',
                'drawer_menu',
                0,
                1,
                'user_backed_out',
            ),
        )
        conn.commit()
        conn.close()

        self.module.DB_PATH = self.temp_db.name

    def cleanup_temp_db(self):
        if os.path.exists(self.temp_db.name):
            os.unlink(self.temp_db.name)

    def test_get_user_moods_includes_breathing_sessions_and_aggregates(self):
        start_date = self.module.datetime(2026, 3, 20)
        end_date = self.module.datetime(2026, 3, 22)

        moods = self.module.get_user_moods(1, start_date, end_date)

        self.assertIn('2026-03-20', moods)
        self.assertIn('2026-03-21', moods)

        march_20 = moods['2026-03-20']
        self.assertEqual(march_20['rating'], 3)
        self.assertEqual(march_20['breathing_summary']['session_count'], 1)
        self.assertEqual(march_20['breathing_summary']['completed_session_count'], 1)
        self.assertEqual(march_20['breathing_summary']['total_duration_seconds'], 300)
        self.assertEqual(march_20['breathing_sessions'][0]['routine_type'], 'box_breathing')

        march_21 = moods['2026-03-21']
        self.assertIsNone(march_21['rating'])
        self.assertTrue(march_21['breathing_summary']['used_breathing'])
        self.assertEqual(march_21['breathing_summary']['partial_session_count'], 1)
        self.assertEqual(march_21['breathing_sessions'][0]['status'], 'exited_early')
        self.assertEqual(march_21['breathing_sessions'][0]['exit_reason'], 'user_backed_out')

    def test_build_breathing_sessions_payload_groups_sessions_by_date(self):
        rows = [
            ('2026-03-20', 'box_breathing', '3_cycles', 3, 3, 'completed', 'a', 'b', 120, 'home_panel', 1, 1, None),
            ('2026-03-20', 'four_seven_eight', 'infinite', None, 6, 'interrupted', 'c', 'd', 240, 'drawer_menu', 0, 0, 'app_backgrounded'),
        ]

        sessions_by_date, aggregates_by_date = self.module.build_breathing_sessions_payload(rows)

        self.assertEqual(len(sessions_by_date['2026-03-20']), 2)
        self.assertEqual(aggregates_by_date['2026-03-20']['session_count'], 2)
        self.assertEqual(aggregates_by_date['2026-03-20']['completed_session_count'], 1)
        self.assertEqual(aggregates_by_date['2026-03-20']['partial_session_count'], 1)
        self.assertEqual(aggregates_by_date['2026-03-20']['total_completed_cycles'], 9)
        self.assertEqual(aggregates_by_date['2026-03-20']['total_duration_seconds'], 360)


if __name__ == '__main__':
    unittest.main()
