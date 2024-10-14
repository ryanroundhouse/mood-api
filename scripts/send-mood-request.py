import sqlite3
import requests
import os
from dotenv import load_dotenv
import uuid
import random
from datetime import datetime
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
    
    # Modify the SQL query to use date functions
    sql_query = """
        SELECT COUNT(*) FROM moods 
        WHERE userId = ? AND DATE(substr(datetime, 1, 10)) = ?
    """    
    cursor.execute(sql_query, (user_id, today.isoformat()))
    count = cursor.fetchone()[0]
    conn.close()
    return count == 0

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

def main():
    users = get_users_with_notifications()
    for user_id, email in users:
        if user_needs_reminder(user_id):
            auth_code = generate_auth_code(user_id)
            send_email(email, user_id, auth_code)
        else:
            print(f"User {user_id} has already submitted a mood entry today. Skipping reminder.")

if __name__ == "__main__":
    main()
