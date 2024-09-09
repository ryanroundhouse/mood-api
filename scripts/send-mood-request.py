import sqlite3
import requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import time
from dotenv import load_dotenv
import uuid
import random

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
        JOIN notifications ON users.id = notifications.userId 
        WHERE users.isVerified = 1 AND notifications.dailyNotifications = 1
    """)
    users = cursor.fetchall()
    conn.close()
    return users

def generate_auth_code(user_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    auth_code = os.urandom(16).hex()
    cursor.execute("INSERT INTO mood_auth_codes (userId, authCode, expiresAt) VALUES (?, ?, ?)",
                   (user_id, auth_code, time.time() * 1000 + 86400))
    conn.commit()
    conn.close()
    return auth_code

def send_email(to_email, auth_code):
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
        <title>Submit Mood - MoodTracker</title>
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
                "from": f"MoodTracker <{SENDER_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content,
                "h:Message-ID": message_id,
            }
        )
        response.raise_for_status()
        print(f"Email sent successfully to {to_email}")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send email to {to_email}. Error: {str(e)}")

def main():
    users = get_users_with_notifications()
    for user_id, email in users:
        auth_code = generate_auth_code(user_id)
        send_email(email, auth_code)

if __name__ == "__main__":
    main()