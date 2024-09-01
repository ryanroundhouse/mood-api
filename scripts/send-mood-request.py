import sqlite3
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import time
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Email configuration
SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
SENDER_EMAIL = os.getenv("GMAIL_USERNAME")
SENDER_PASSWORD = os.getenv("GMAIL_PASSWORD")

# Database configuration
DB_PATH = "../database.sqlite"

def get_users():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, email FROM users WHERE isVerified = 1")
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
    subject = "How was your day?"
    
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
        link = f"http://localhost:3000/mood.html?rating={i}&auth_code={auth_code}"
        html_content += f'<a href="{link}" class="mood-option">{emoji}</a>'
    
    html_content += """
        </div>
        <p>Click on an emoji to submit your mood.</p>
    </body>
    </html>
    """

    msg = MIMEMultipart()
    msg['From'] = SENDER_EMAIL
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(html_content, 'html'))

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.send_message(msg)
        print(f"Email sent successfully to {to_email}")
    except Exception as e:
        print(f"Failed to send email to {to_email}. Error: {str(e)}")

def main():
    users = get_users()
    for user_id, email in users:
        auth_code = generate_auth_code(user_id)
        send_email(email, auth_code)

if __name__ == "__main__":
    main()