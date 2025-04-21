import sqlite3
import requests
import os
from dotenv import load_dotenv
import uuid
import random
from datetime import datetime, timedelta
import pytz

# Add this function at the top of your file, after the imports
def adapt_date(val):
    return val.isoformat()

# Add this constant after the imports
EST_TIMEZONE = pytz.timezone('America/New_York')

# Load environment variables
load_dotenv()

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")
BASE_URL = os.getenv("MOOD_SITE_URL", "http://localhost:3000")

# Database configuration
DB_PATH = "../database.sqlite"

def get_users_with_notifications():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT users.id, users.email 
        FROM users 
        JOIN user_settings ON users.id = user_settings.userId 
        WHERE users.isVerified = 1 AND user_settings.emailDailyNotifications = 1
    """)
    users = cursor.fetchall()
    conn.close()
    return users

def user_needs_reminder(user_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Get the current date in EST timezone
    today = datetime.now(EST_TIMEZONE).date()
    
    # Query checks if a mood exists for the user *today*
    sql_query = """
        SELECT COUNT(*) FROM moods 
        WHERE userId = ? AND DATE(substr(datetime, 1, 10)) = ?
    """    
    cursor.execute(sql_query, (user_id, today.isoformat()))
    count = cursor.fetchone()[0]
    conn.close()
    return count == 0

def get_last_mood_entry_date(user_id):
    """Fetches the date of the last mood entry for a given user."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    sql_query = """
        SELECT MAX(DATE(substr(datetime, 1, 10))) 
        FROM moods 
        WHERE userId = ?
    """
    cursor.execute(sql_query, (user_id,))
    result = cursor.fetchone()
    conn.close()
    
    if result and result[0]:
        # Parse the date string 'YYYY-MM-DD' into a date object
        return datetime.strptime(result[0], '%Y-%m-%d').date()
    return None

def generate_auth_code(user_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    auth_code = os.urandom(16).hex()
    expiration_time = int(datetime.now(EST_TIMEZONE).timestamp() + 86400) * 1000
    cursor.execute("INSERT INTO mood_auth_codes (userId, authCode, expiresAt) VALUES (?, ?, ?)",
                   (user_id, auth_code, expiration_time))
    conn.commit()
    conn.close()
    return auth_code

def send_email(to_email, user_id, auth_code):
    subjects = [
        "How did your day go?",
        "Tell us about your day!",
        "How was your day today?",
        "Rate your day—how did it feel?",
        "How would you sum up your day?",
        "Reflect on your day—how was it?",
        "How are you feeling about today?",
        "Quick check-in: How was today?"
    ]
    subject = random.choice(subjects)
    
    html_content = """
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Submit Mood - Moodful</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
            }
            h1 {
                color: #6a89cc;
            }
            .mood-options {
                display: flex;
                justify-content: space-around;
                margin-bottom: 20px;
            }
            .mood-option {
                font-size: 2rem;
                text-decoration: none;
            }
        </style>
    </head>
    <body>
        <h1>How was your day?</h1>
        <p>Select the emoji that best represents your mood today.</p>
        <div class="mood-options">
    """
    
    emojis = ["😢", "😕", "😐", "🙂", "😄"]
    for i, emoji in enumerate(emojis):
        link = f"{BASE_URL}/mood.html?rating={i}&auth_code={auth_code}"
        html_content += f'<a href="{link}" class="mood-option">{emoji}</a>'
    
    html_content += """
        </div>
        <p>Click on an emoji to submit your mood.</p>
    </body>
    </html>
    """

    try:
        message_id = f"<{uuid.uuid4()}@{MAILGUN_DOMAIN}>"
        response = requests.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
            auth=("api", MAILGUN_API_KEY),
            data={
                "from": f"Moodful <{SENDER_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content,
                "h:Message-ID": message_id,
            }
        )
        response.raise_for_status()
        print(f"Email sent successfully to user{user_id}")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send email to user {user_id}. Error: {str(e)}")

def send_goodbye_email(to_email, user_id):
    """Sends a goodbye email to the user."""
    subject = "Checking In - Moodful"
    html_content = """
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Checking In - Moodful</title>
        <style>
            body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }}
            h1 {{ color: #6a89cc; }}
        </style>
    </head>
    <body>
        <h1>Checking In</h1>
        <p>Hi there,</p>
        <p>We noticed you haven't logged your mood on Moodful in a while.</p>
        <p>We understand life gets busy! We've disabled daily email reminders for now to avoid cluttering your inbox. You can always re-enable them in your account settings if you decide to start tracking your mood again.</p>
        <p>If you have any feedback or decided Moodful wasn't right for you, we'd love to hear why. Your input helps us improve.</p>
        <p>Wishing you all the best,</p>
        <p>The Moodful Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #777;">You can manage your notification preferences <a href="{BASE_URL}/settings">here</a>.</p>
    </body>
    </html>
    """.format(BASE_URL=BASE_URL)

    try:
        message_id = f"<{uuid.uuid4()}@{MAILGUN_DOMAIN}>"
        response = requests.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
            auth=("api", MAILGUN_API_KEY),
            data={
                "from": f"Moodful <{SENDER_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content,
                "h:Message-ID": message_id,
            }
        )
        response.raise_for_status()
        print(f"Goodbye email sent successfully to user {user_id}")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send goodbye email to user {user_id}. Error: {str(e)}")

def disable_notifications(user_id):
    """Disables email notifications for the user in the database."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("""
            UPDATE user_settings 
            SET emailDailyNotifications = 0 
            WHERE userId = ?
        """, (user_id,))
        conn.commit()
        print(f"Disabled email notifications for user {user_id}")
    except sqlite3.Error as e:
        print(f"Failed to disable notifications for user {user_id}. Error: {e}")
    finally:
        conn.close()

def main():
    users = get_users_with_notifications() # Fetches users with emailDailyNotifications = 1
    today = datetime.now(EST_TIMEZONE).date()
    one_week_ago = today - timedelta(weeks=1)
    four_weeks_ago = today - timedelta(weeks=4)
    is_weekly_reminder_day = today.weekday() == 0 # Monday is 0

    for user_id, email in users:
        last_submission_date = get_last_mood_entry_date(user_id)
        # Delay calling user_needs_reminder until it's actually needed
        # needs_today_reminder = user_needs_reminder(user_id) 

        if last_submission_date:
            # User has submitted before
            if last_submission_date < four_weeks_ago:
                # Case 1: Inactive > 4 weeks -> Send goodbye and disable
                # No need to check needs_today_reminder here
                print(f"User {user_id} inactive > 4 weeks. Sending goodbye and disabling notifications.")
                send_goodbye_email(email, user_id)
                disable_notifications(user_id)
                continue # Process next user

            elif last_submission_date < one_week_ago:
                # Case 2: Inactive > 1 week and <= 4 weeks -> Send weekly (Monday) reminder
                needs_today_reminder = user_needs_reminder(user_id) # Check here
                if is_weekly_reminder_day and needs_today_reminder:
                    print(f"User {user_id} inactive > 1 week. Sending weekly reminder.")
                    auth_code = generate_auth_code(user_id)
                    send_email(email, user_id, auth_code)
                elif not needs_today_reminder:
                     print(f"User {user_id} inactive > 1 week, but submitted today. Skipping.")
                else: # Inactive > 1 week, needs reminder, but not Monday
                    print(f"User {user_id} inactive > 1 week. Skipping daily reminder (not weekly reminder day).")
            
            else:
                # Case 3: Active within the last week -> Send daily reminder if needed
                needs_today_reminder = user_needs_reminder(user_id) # Check here
                if needs_today_reminder:
                    print(f"User {user_id} active <= 1 week. Sending daily reminder.")
                    auth_code = generate_auth_code(user_id)
                    send_email(email, user_id, auth_code)
                else:
                    print(f"User {user_id} active <= 1 week, but submitted today. Skipping reminder.")
        
        else:
            # User has never submitted before -> Send daily reminder if needed
            needs_today_reminder = user_needs_reminder(user_id) # Check here
            if needs_today_reminder:
                 print(f"User {user_id} (new user). Sending first reminder.")
                 auth_code = generate_auth_code(user_id)
                 send_email(email, user_id, auth_code)
            # else: Implicitly handles new user who somehow submitted today


if __name__ == "__main__":
    main() 