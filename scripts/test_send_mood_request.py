import unittest
from unittest.mock import patch, MagicMock, call
from datetime import date, timedelta, datetime
import pytz
import sys
import os

# Remove sys.path modification
# project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# sys.path.insert(0, project_root)

# Remove sys.path modification for scripts dir
# script_dir = os.path.dirname(os.path.abspath(__file__))
# sys.path.insert(0, script_dir)

# Now import the script components using package path
try:
    # import send_mood_request as smr # Old direct import
    from scripts import send_mood_request as smr
except ImportError as e:
    print(f"Error importing send_mood_request: {e}")
    print("Ensure the script is in the same directory or sys.path is correctly set.")
    # Print sys.path for debugging
    print("sys.path:", sys.path)
    sys.exit(1)

# Define EST timezone for consistency with the script
EST_TIMEZONE = pytz.timezone('America/New_York')

class TestSendMoodRequest(unittest.TestCase):

    def setUp(self):
        # Reset mocks for each test
        # Remove wraps=datetime, we control the full mock chain now
        self.mock_datetime_patcher = patch('scripts.send_mood_request.datetime') 
        self.mock_datetime = self.mock_datetime_patcher.start()
        self.addCleanup(self.mock_datetime_patcher.stop)
        
        self.mock_get_users = patch('scripts.send_mood_request.get_users_with_notifications').start()
        self.mock_get_last_mood = patch('scripts.send_mood_request.get_last_mood_entry_date').start()
        self.mock_needs_reminder = patch('scripts.send_mood_request.user_needs_reminder').start()
        self.mock_gen_code = patch('scripts.send_mood_request.generate_auth_code').start()
        self.mock_send_email = patch('scripts.send_mood_request.send_email').start()
        self.mock_send_goodbye = patch('scripts.send_mood_request.send_goodbye_email').start()
        self.mock_disable_notif = patch('scripts.send_mood_request.disable_notifications').start()

        # Default mocks
        self.mock_get_users.return_value = [(1, 'test@example.com')]
        self.mock_gen_code.return_value = 'test_auth_code'
        
        # Ensure BASE_URL is set for email functions if needed by mocks
        # patch.dict doesn't work easily here pre-import, handle manually if required
        smr.BASE_URL = "http://mock.url"

    def set_current_date(self, year, month, day, is_monday=False):
        # Real date object for comparisons and isoformat
        real_today = date(year, month, day)

        # 1. Create the final mock *date* object we want returned by .date()
        mock_date_obj = MagicMock(spec=date)
        mock_date_obj.weekday.return_value = 0 if is_monday else 1 # 0 for Monday
        mock_date_obj.year = year
        mock_date_obj.month = month
        mock_date_obj.day = day
        mock_date_obj.isoformat.return_value = real_today.isoformat()
        # Ensure comparison methods use the real_today object
        mock_date_obj.__sub__ = lambda _, other: real_today.__sub__(other)
        mock_date_obj.__lt__ = lambda _, other: real_today.__lt__(other)
        mock_date_obj.__le__ = lambda _, other: real_today.__le__(other)
        mock_date_obj.__eq__ = lambda _, other: real_today.__eq__(other)
        mock_date_obj.__gt__ = lambda _, other: real_today.__gt__(other)
        mock_date_obj.__ge__ = lambda _, other: real_today.__ge__(other)
        
        # 2. Create a mock *datetime* object that now() will return
        mock_dt_now_obj = MagicMock()
        # Configure its date() method to return our mock_date_obj
        mock_dt_now_obj.date.return_value = mock_date_obj

        # 3. Configure the patched datetime module's now() method
        # It should accept the timezone arg but return our mock_dt_now_obj
        self.mock_datetime.now.return_value = mock_dt_now_obj

    # --- Test Cases ---

    def test_active_user_needs_daily_reminder(self):
        """User submitted 5 days ago, needs reminder today."""
        self.set_current_date(2024, 7, 15) # A Monday, but doesn't matter here
        self.mock_get_last_mood.return_value = date(2024, 7, 10) # 5 days ago
        self.mock_needs_reminder.return_value = True
        
        smr.main()
        
        self.mock_get_users.assert_called_once()
        self.mock_get_last_mood.assert_called_once_with(1)
        self.mock_needs_reminder.assert_called_once_with(1)
        self.mock_gen_code.assert_called_once_with(1)
        self.mock_send_email.assert_called_once_with('test@example.com', 1, 'test_auth_code')
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()

    def test_active_user_submitted_today(self):
        """User submitted 5 days ago, but also today, no reminder needed."""
        self.set_current_date(2024, 7, 15)
        self.mock_get_last_mood.return_value = date(2024, 7, 10)
        self.mock_needs_reminder.return_value = False # Submitted today
        
        smr.main()
        
        self.mock_needs_reminder.assert_called_once_with(1)
        self.mock_gen_code.assert_not_called()
        self.mock_send_email.assert_not_called()
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()

    def test_new_user_needs_reminder(self):
        """User never submitted before, needs reminder."""
        self.set_current_date(2024, 7, 15)
        self.mock_get_last_mood.return_value = None # Never submitted
        self.mock_needs_reminder.return_value = True
        
        smr.main()

        self.mock_get_last_mood.assert_called_once_with(1)
        self.mock_needs_reminder.assert_called_once_with(1)
        self.mock_gen_code.assert_called_once_with(1)
        self.mock_send_email.assert_called_once_with('test@example.com', 1, 'test_auth_code')
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()

    def test_inactive_1_week_needs_weekly_reminder_on_monday(self):
        """User submitted 10 days ago, needs reminder, it's Monday."""
        self.set_current_date(2024, 7, 15, is_monday=True) # A Monday
        self.mock_get_last_mood.return_value = date(2024, 7, 5) # 10 days ago (> 1 week)
        self.mock_needs_reminder.return_value = True
        
        smr.main()

        self.mock_get_last_mood.assert_called_once_with(1)
        self.mock_needs_reminder.assert_called_once_with(1)
        self.mock_gen_code.assert_called_once_with(1)
        self.mock_send_email.assert_called_once_with('test@example.com', 1, 'test_auth_code') # Sends regular email as weekly reminder
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()

    def test_inactive_1_week_needs_reminder_not_monday(self):
        """User submitted 10 days ago, needs reminder, but it's Tuesday."""
        self.set_current_date(2024, 7, 16, is_monday=False) # A Tuesday
        self.mock_get_last_mood.return_value = date(2024, 7, 6) # 10 days ago
        self.mock_needs_reminder.return_value = True
        
        smr.main()

        self.mock_needs_reminder.assert_called_once_with(1)
        self.mock_gen_code.assert_not_called()
        self.mock_send_email.assert_not_called() # No email sent
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()

    def test_inactive_1_week_submitted_today_on_monday(self):
        """User submitted 10 days ago, but also today, it's Monday."""
        self.set_current_date(2024, 7, 15, is_monday=True) # A Monday
        self.mock_get_last_mood.return_value = date(2024, 7, 5) # 10 days ago
        self.mock_needs_reminder.return_value = False # Submitted today
        
        smr.main()

        self.mock_needs_reminder.assert_called_once_with(1)
        self.mock_gen_code.assert_not_called()
        self.mock_send_email.assert_not_called()
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()
        
    def test_inactive_just_under_4_weeks_needs_weekly_reminder_on_monday(self):
        """User submitted 27 days ago, needs reminder, it's Monday."""
        self.set_current_date(2024, 7, 29, is_monday=True) # A Monday
        self.mock_get_last_mood.return_value = date(2024, 7, 2) # 27 days ago
        self.mock_needs_reminder.return_value = True
        
        smr.main()

        self.mock_gen_code.assert_called_once_with(1)
        self.mock_send_email.assert_called_once_with('test@example.com', 1, 'test_auth_code')
        self.mock_send_goodbye.assert_not_called()
        self.mock_disable_notif.assert_not_called()

    def test_inactive_over_4_weeks_sends_goodbye(self):
        """User submitted 30 days ago."""
        self.set_current_date(2024, 8, 1) # A Thursday
        self.mock_get_last_mood.return_value = date(2024, 7, 2) # 30 days ago (> 4 weeks)
        # needs_reminder doesn't matter here, but set it for completeness
        self.mock_needs_reminder.return_value = True 
        
        smr.main()

        self.mock_get_last_mood.assert_called_once_with(1)
        # user_needs_reminder is *not* called when user is inactive > 4 weeks
        self.mock_needs_reminder.assert_not_called() 
        self.mock_gen_code.assert_not_called()
        self.mock_send_email.assert_not_called() 
        self.mock_send_goodbye.assert_called_once_with('test@example.com', 1)
        self.mock_disable_notif.assert_called_once_with(1)

    def test_inactive_over_4_weeks_submitted_today(self):
        """User submitted 30 days ago, also submitted today (edge case). Should still send goodbye."""
        self.set_current_date(2024, 8, 1)
        self.mock_get_last_mood.return_value = date(2024, 7, 2) # 30 days ago
        # Mocking needs_reminder just in case, though it shouldn't be called
        self.mock_needs_reminder.return_value = False 
        
        smr.main()

        self.mock_get_last_mood.assert_called_once_with(1)
        self.mock_needs_reminder.assert_not_called() 
        self.mock_gen_code.assert_not_called()
        self.mock_send_email.assert_not_called() 
        self.mock_send_goodbye.assert_called_once_with('test@example.com', 1)
        self.mock_disable_notif.assert_called_once_with(1)

    def test_multiple_users_different_states(self):
        """Test with multiple users in various states."""
        self.set_current_date(2024, 7, 15, is_monday=True) # Monday
        today = date(2024, 7, 15)
        
        # User 1: Active, needs reminder
        user1 = (1, 'active@example.com')
        # User 2: Inactive > 1 week, needs reminder (gets weekly)
        user2 = (2, 'weekly@example.com')
        # User 3: Inactive > 4 weeks (gets goodbye)
        user3 = (3, 'goodbye@example.com')
        # User 4: Active, submitted today
        user4 = (4, 'submitted@example.com')
        # User 5: New user
        user5 = (5, 'new@example.com')
        # User 6: Inactive > 1 week, needs reminder, but it's Tuesday (for a different test)
        # We'll skip this one for the Monday test run

        self.mock_get_users.return_value = [user1, user2, user3, user4, user5]

        def mock_last_mood_side_effect(user_id):
            if user_id == 1: return today - timedelta(days=3)       # Active
            if user_id == 2: return today - timedelta(days=10)      # Weekly
            if user_id == 3: return today - timedelta(days=30)      # Goodbye
            if user_id == 4: return today - timedelta(days=3)       # Active (but submitted today)
            if user_id == 5: return None                            # New
            return None
        self.mock_get_last_mood.side_effect = mock_last_mood_side_effect

        def mock_needs_reminder_side_effect(user_id):
            if user_id == 1: return True
            if user_id == 2: return True
            if user_id == 3: return True # Doesn't matter, checked before this
            if user_id == 4: return False # Submitted today
            if user_id == 5: return True
            return False
        self.mock_needs_reminder.side_effect = mock_needs_reminder_side_effect

        smr.main()

        # Check calls for each user type
        self.assertEqual(self.mock_send_email.call_count, 3) # Active, Weekly, New
        self.mock_send_email.assert_has_calls([
            call('active@example.com', 1, 'test_auth_code'),
            call('weekly@example.com', 2, 'test_auth_code'),
            call('new@example.com', 5, 'test_auth_code')
        ], any_order=True)
        
        self.mock_send_goodbye.assert_called_once_with('goodbye@example.com', 3)
        self.mock_disable_notif.assert_called_once_with(3)

        # Ensure generate_auth_code called only for those getting emails
        self.assertEqual(self.mock_gen_code.call_count, 3)
        self.mock_gen_code.assert_has_calls([call(1), call(2), call(5)], any_order=True)


if __name__ == '__main__':
    unittest.main(argv=['first-arg-is-ignored'], exit=False) 