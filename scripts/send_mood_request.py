import sqlite3
import requests
import os
from dotenv import load_dotenv
import uuid
import random
from datetime import datetime, timedelta
import pytz
import logging
import pathlib

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# Load environment variables from project root .env file
script_dir = pathlib.Path(__file__).parent.absolute()
project_root = script_dir.parent
dotenv_path = project_root / '.env'
load_dotenv(dotenv_path=dotenv_path)

# Add this function at the top of your file, after the imports
def adapt_date(val):
    return val.isoformat()

# Add this constant after the imports
EST_TIMEZONE = pytz.timezone('America/New_York')

# Load environment variables
logging.info(f"Loading environment variables from: {dotenv_path}")

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")
BASE_URL = os.getenv("MOOD_SITE_URL", "http://localhost:3000")

logging.info(f"Environment variables loaded - MAILGUN_DOMAIN: {MAILGUN_DOMAIN}, BASE_URL: {BASE_URL}")

# Database configuration
DB_PATH = os.path.join(project_root, "database.sqlite")
logging.info(f"Database path: {DB_PATH}")

def get_users_with_notifications():
    logging.info("Fetching users with notifications enabled")
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT users.id, users.email 
            FROM users 
            JOIN user_settings ON users.id = user_settings.userId 
            WHERE users.isVerified = 1 AND user_settings.emailDailyNotifications = 1
        """)
        users = cursor.fetchall()
        logging.info(f"Found {len(users)} users with notifications enabled")
        conn.close()
        return users
    except sqlite3.Error as e:
        logging.error(f"Database error fetching users with notifications: {str(e)}")
        return []

def user_needs_reminder(user_id):
    logging.info(f"Checking if user {user_id} needs a reminder today")
    try:
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
        
        needs_reminder = count == 0
        logging.info(f"User {user_id} {'needs' if needs_reminder else 'does not need'} a reminder today. Found {count} entries.")
        return needs_reminder
    except sqlite3.Error as e:
        logging.error(f"Database error checking if user {user_id} needs reminder: {str(e)}")
        return True  # Fail-safe: send reminder if error

def get_last_mood_entry_date(user_id):
    """Fetches the date of the last mood entry for a given user."""
    logging.info(f"Fetching last mood entry date for user {user_id}")
    try:
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
            last_date = datetime.strptime(result[0], '%Y-%m-%d').date()
            logging.info(f"Last mood entry for user {user_id} was on {last_date}")
            return last_date
        logging.info(f"No previous mood entries found for user {user_id}")
        return None
    except sqlite3.Error as e:
        logging.error(f"Database error fetching last mood date for user {user_id}: {str(e)}")
        return None

def generate_auth_code(user_id):
    logging.info(f"Generating auth code for user {user_id}")
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        auth_code = os.urandom(16).hex()
        expiration_time = int(datetime.now(EST_TIMEZONE).timestamp() + 86400) * 1000
        cursor.execute("INSERT INTO mood_auth_codes (userId, authCode, expiresAt) VALUES (?, ?, ?)",
                       (user_id, auth_code, expiration_time))
        conn.commit()
        conn.close()
        logging.info(f"Auth code generated and stored for user {user_id}")
        return auth_code
    except sqlite3.Error as e:
        logging.error(f"Database error generating auth code for user {user_id}: {str(e)}")
        # Create a fallback auth code - it won't be saved in the DB, but this prevents catastrophic failure
        return os.urandom(16).hex()

def get_or_create_unsubscribe_token(user_id):
    logging.info(f"Getting unsubscribe token for user {user_id}")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT unsubscribeToken FROM user_settings WHERE userId = ?", (user_id,))
    row = cursor.fetchone()
    if row and row[0]:
        token = row[0]
        logging.info(f"Found existing unsubscribe token for user {user_id}")
    else:
        token = os.urandom(16).hex()
        logging.info(f"Generated new unsubscribe token for user {user_id}: {token}")
        try:
            cursor.execute("UPDATE user_settings SET unsubscribeToken = ? WHERE userId = ?", (token, user_id))
            conn.commit()
            logging.info(f"Stored new unsubscribe token for user {user_id}")
        except sqlite3.Error as e:
            logging.error(f"Database error saving unsubscribe token for user {user_id}: {str(e)}")
    conn.close()
    return token

def send_email(to_email, user_id, auth_code):
    logging.info(f"Preparing to send email to {to_email} (user {user_id})")
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
    logging.info(f"Selected subject: '{subject}'")
    
    # Get or create unsubscribe token and build link
    try:
        unsubscribe_token = get_or_create_unsubscribe_token(user_id)
        unsubscribe_link = f"{BASE_URL}/api/user/unsubscribe?token={unsubscribe_token}&type=daily"
        unsubscribe_all_link = f"{BASE_URL}/api/user/unsubscribe?token={unsubscribe_token}&type=all"
        logging.info(f"Unsubscribe link created: {unsubscribe_link}")
    except Exception as e:
        logging.error(f"Error generating unsubscribe token: {str(e)}")
        unsubscribe_link = f"{BASE_URL}/settings"  # Fallback to settings page
        unsubscribe_all_link = f"{BASE_URL}/settings"
    
    logging.info(f"Building email HTML for user {user_id}")
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
            .footer {
                margin-top: 30px;
                font-size: 0.9em;
                color: #888;
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
    
    html_content += f"""
        </div>
        <p>Click on an emoji to submit your mood.</p>
        <div class="footer">
            <p>If you no longer wish to receive daily mood emails, you can <a href="{unsubscribe_link}">unsubscribe from daily reminders</a>.</p>
            <p>If you wish to unsubscribe from all emails, you can <a href="{unsubscribe_all_link}">unsubscribe from all Moodful emails</a>.</p>
        </div>
    </body>
    </html>
    """

    try:
        logging.info(f"Sending email to {to_email} via Mailgun API")
        message_id = f"<{uuid.uuid4()}@{MAILGUN_DOMAIN}>"
        
        # Log API credentials (masked)
        logging.info(f"Using Mailgun domain: {MAILGUN_DOMAIN}")
        api_key_masked = MAILGUN_API_KEY[:4] + "..." if MAILGUN_API_KEY else "None"
        logging.info(f"Using Mailgun API key: {api_key_masked}")
        
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
        logging.info(f"Email sent successfully to user {user_id}. Status code: {response.status_code}")
        print(f"Email sent successfully to user {user_id}")
    except requests.exceptions.RequestException as e:
        logging.error(f"Failed to send email to user {user_id}. Error: {str(e)}")
        print(f"Failed to send email to user {user_id}. Error: {str(e)}")
        if hasattr(e, 'response') and e.response:
            logging.error(f"Response status: {e.response.status_code}")
            logging.error(f"Response text: {e.response.text}")

def send_goodbye_email(to_email, user_id):
    """Sends a goodbye email to the user."""
    subject = "Checking In - Moodful"
    
    # Get or create unsubscribe token and build link
    try:
        unsubscribe_token = get_or_create_unsubscribe_token(user_id)
        resubscribe_link = f"{BASE_URL}/settings"
    except Exception as e:
        logging.error(f"Error generating unsubscribe token for goodbye email: {str(e)}")
        resubscribe_link = f"{BASE_URL}/settings"
    
    html_content = f"""
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Checking In - Moodful</title>
        <style>
            body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }}
            h1 {{ color: #6a89cc; }}
            .footer {{ margin-top: 30px; font-size: 0.9em; color: #888; border-top: 1px solid #ddd; padding-top: 15px; }}
        </style>
    </head>
    <body>
        <h1>Checking In</h1>
        <p>Hi there,</p>
        <p>We noticed you haven't logged your mood on Moodful in a while.</p>
        <p>We understand life gets busy! We've disabled daily email reminders for now to avoid cluttering your inbox. You can always re-enable them in your <a href="{resubscribe_link}">account settings</a> if you decide to start tracking your mood again.</p>
        <p>If you have any feedback or decided Moodful wasn't right for you, we'd love to hear why. Your input helps us improve.</p>
        <p>Wishing you all the best,</p>
        <p>The Moodful Team</p>
    </body>
    </html>
    """

    try:
        logging.info(f"Sending goodbye email to {to_email}")
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
        logging.info(f"Goodbye email sent successfully to user {user_id}")
    except requests.exceptions.RequestException as e:
        logging.error(f"Failed to send goodbye email to user {user_id}. Error: {str(e)}")
        if hasattr(e, 'response') and e.response:
            logging.error(f"Response status: {e.response.status_code}")
            logging.error(f"Response text: {e.response.text}")

def disable_notifications(user_id):
    """Disables email notifications for the user in the database."""
    logging.info(f"Disabling email notifications for user {user_id}")
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE user_settings 
            SET emailDailyNotifications = 0 
            WHERE userId = ?
        """, (user_id,))
        conn.commit()
        conn.close()
        logging.info(f"Disabled email notifications for user {user_id}")
    except sqlite3.Error as e:
        logging.error(f"Database error disabling notifications for user {user_id}: {str(e)}")

def main():
    logging.info("Starting mood request email script")
    logging.info(f"Using database at {DB_PATH}")
    
    try:
        users = get_users_with_notifications()
        logging.info(f"Processing {len(users)} users with notifications enabled")
        
        today = datetime.now(EST_TIMEZONE).date()
        one_week_ago = today - timedelta(weeks=1)
        four_weeks_ago = today - timedelta(weeks=4)
        is_weekly_reminder_day = today.weekday() == 0 # Monday is 0
        
        logging.info(f"Date info - Today: {today}, Weekly reminder day: {is_weekly_reminder_day}")
        logging.info(f"Cutoff dates - One week ago: {one_week_ago}, Four weeks ago: {four_weeks_ago}")

        for user_id, email in users:
            logging.info(f"Processing user {user_id} with email {email}")
            last_submission_date = get_last_mood_entry_date(user_id)
            
            if last_submission_date:
                logging.info(f"User {user_id} last submitted on {last_submission_date}")
                # User has submitted before
                if last_submission_date < four_weeks_ago:
                    # Case 1: Inactive > 4 weeks -> Send goodbye and disable
                    logging.info(f"User {user_id} inactive > 4 weeks. Sending goodbye and disabling notifications.")
                    send_goodbye_email(email, user_id)
                    disable_notifications(user_id)
                    continue # Process next user

                elif last_submission_date < one_week_ago:
                    # Case 2: Inactive > 1 week and <= 4 weeks -> Send weekly (Monday) reminder
                    needs_today_reminder = user_needs_reminder(user_id) # Check here
                    if is_weekly_reminder_day and needs_today_reminder:
                        logging.info(f"User {user_id} inactive > 1 week. Sending weekly reminder.")
                        auth_code = generate_auth_code(user_id)
                        send_email(email, user_id, auth_code)
                    elif not needs_today_reminder:
                        logging.info(f"User {user_id} inactive > 1 week, but submitted today. Skipping.")
                    else: # Inactive > 1 week, needs reminder, but not Monday
                        logging.info(f"User {user_id} inactive > 1 week. Skipping daily reminder (not weekly reminder day).")
                
                else:
                    # Case 3: Active within the last week -> Send daily reminder if needed
                    needs_today_reminder = user_needs_reminder(user_id) # Check here
                    if needs_today_reminder:
                        logging.info(f"User {user_id} active <= 1 week. Sending daily reminder.")
                        auth_code = generate_auth_code(user_id)
                        send_email(email, user_id, auth_code)
                    else:
                        logging.info(f"User {user_id} active <= 1 week, but submitted today. Skipping reminder.")
            
            else:
                # User has never submitted before -> Send daily reminder if needed
                logging.info(f"User {user_id} has never submitted a mood before")
                needs_today_reminder = user_needs_reminder(user_id) # Check here
                if needs_today_reminder:
                    logging.info(f"User {user_id} (new user). Sending first reminder.")
                    auth_code = generate_auth_code(user_id)
                    send_email(email, user_id, auth_code)
                else:
                    logging.info(f"User {user_id} (new user) but submitted today already. Skipping.")
                    
        logging.info("Mood request email script completed successfully")
    except Exception as e:
        logging.error(f"Unexpected error in main process: {str(e)}")

if __name__ == "__main__":
    main() 